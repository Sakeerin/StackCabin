// Internal hosted-Windows acceptance launcher. Keeps the current user/credential
// identity while disabling administrator groups and privileges in child processes.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace StackCabinAcceptance {
    public static class StandardUser {
        [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct JobLimits {
            public BasicLimits Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr original, uint flags, uint disabledCount, SidAndAttributes[] disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, IntPtr restricted, out IntPtr token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);

        static void Check(bool success, string operation) {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static IntPtr LimitedToken() {
            IntPtr original = IntPtr.Zero, limited = IntPtr.Zero;
            var groups = new SidAndAttributes[2];
            try {
                Check(OpenProcessToken(GetCurrentProcess(), 0x000B, out original), "Open acceptance token");
                var roles = new[] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.BuiltinPowerUsersSid };
                for (int index = 0; index < roles.Length; index++) {
                    var sid = new SecurityIdentifier(roles[index], null);
                    var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
                    groups[index].Sid = Marshal.AllocHGlobal(bytes.Length);
                    Marshal.Copy(bytes, 0, groups[index].Sid, bytes.Length);
                }
                Check(CreateRestrictedToken(original, 1, 2, groups, 0, IntPtr.Zero, 0, IntPtr.Zero, out limited), "Create standard acceptance token");
                using (var identity = new WindowsIdentity(limited))
                using (var caller = WindowsIdentity.GetCurrent()) {
                    var principal = new WindowsPrincipal(identity);
                    if (!identity.User.Equals(caller.User) || principal.IsInRole(WindowsBuiltInRole.Administrator) || principal.IsInRole(WindowsBuiltInRole.PowerUser))
                        throw new InvalidOperationException("The acceptance token must retain the user SID and disable administrative membership");
                }
                var result = limited; limited = IntPtr.Zero; return result;
            } finally {
                if (original != IntPtr.Zero) CloseHandle(original);
                if (limited != IntPtr.Zero) CloseHandle(limited);
                foreach (var group in groups) if (group.Sid != IntPtr.Zero) Marshal.FreeHGlobal(group.Sid);
            }
        }
        public static void VerifyIdentity() {
            var token = LimitedToken(); CloseHandle(token);
        }
        public static string Quote(string value) {
            if (value.IndexOf('\0') >= 0) throw new ArgumentException("NUL in process argument");
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char character in value) {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                result.Append(character); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public static int Run(string application, string[] arguments, string directory, string output) {
            if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
                throw new InvalidOperationException("Process acceptance requires a disposable hosted runner");
            IntPtr token = IntPtr.Zero, job = IntPtr.Zero, input = IntPtr.Zero;
            var process = new ProcessInfo(); bool finished = false;
            try {
                token = LimitedToken();
                job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create acceptance process job");
                var limits = new JobLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))), "Contain acceptance process tree");
                var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
                input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
                Check(input != new IntPtr(-1), "Open acceptance input");
                using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                    var handle = stream.SafeFileHandle.DangerousGetHandle();
                    Check(SetHandleInformation(handle, 1, 1), "Share acceptance output");
                    var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x101, Show = 0, Input = input, Output = handle, Error = handle };
                    var command = new StringBuilder(Quote(application));
                    foreach (var argument in arguments ?? new string[0]) command.Append(' ').Append(Quote(argument));
                    Check(CreateProcessAsUserW(token, application, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out process), "Launch standard-user acceptance process");
                    Check(AssignProcessToJobObject(job, process.Process), "Assign acceptance process tree");
                    Check(ResumeThread(process.Thread) != uint.MaxValue, "Resume acceptance process");
                    uint wait = WaitForSingleObject(process.Process, 600000);
                    if (wait == 258) throw new TimeoutException("Acceptance process exceeded ten minutes");
                    Check(wait == 0, "Wait for acceptance process");
                    uint code; Check(GetExitCodeProcess(process.Process, out code), "Read acceptance exit status");
                    finished = true; return unchecked((int)code);
                }
            } finally {
                if (!finished && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
                if (token != IntPtr.Zero) CloseHandle(token);
            }
        }
    }
}
