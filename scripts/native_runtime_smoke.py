"""Exercise relocated Unix runtimes using private, disposable loopback services."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import struct
import subprocess
import tempfile
import time


_secrets = []


def password():
    value = secrets.token_hex(32)
    _secrets.append(value)
    return value


def redact(text):
    for value in _secrets:
        text = text.replace(value, "[redacted]")
    return text


def execute(args, *, env=None, sql=None, stdout=None):
    result = subprocess.run([str(a) for a in args], env=env, input=sql, text=True,
                            stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        details = (result.stderr or "") + "\n" + (result.stdout or "")
        raise RuntimeError(redact(f"{Path(args[0]).name} failed: {details[-8000:]}"))
    return result.stdout


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@contextmanager
def server(args, directory, env=None):
    log = directory / "server.log"
    with log.open("w") as stream:
        process = subprocess.Popen([str(a) for a in args], stdout=stream,
                                   stderr=subprocess.STDOUT, env=env, start_new_session=True)
        try:
            yield process
        except Exception as error:
            details = redact(log.read_text(errors="replace")[-8000:])
            raise RuntimeError(f"{error}\n{details}") from error
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)


def ready(process, check):
    deadline = time.monotonic() + 45
    last = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Server exited during readiness: {process.returncode}")
        try:
            return check()
        except (OSError, RuntimeError) as error:
            last = error
            time.sleep(0.2)
    raise RuntimeError(f"Server did not become ready: {last}")


def fcgi_length(value):
    return bytes([value]) if value < 128 else struct.pack("!I", value | 0x80000000)


def fcgi_record(kind, content):
    padding = (-len(content)) % 8
    return struct.pack("!BBHHBB", 1, kind, 1, len(content), padding, 0) + content + bytes(padding)


def receive(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.recv(size - len(result))
        if not chunk:
            raise RuntimeError("FastCGI ended before completing its response")
        result.extend(chunk)
    return bytes(result)


def fastcgi(port, script):
    parameters = {"SCRIPT_FILENAME": str(script), "SCRIPT_NAME": "/index.php",
                  "DOCUMENT_ROOT": str(script.parent), "REQUEST_METHOD": "GET",
                  "REQUEST_URI": "/", "SERVER_PROTOCOL": "HTTP/1.1", "CONTENT_LENGTH": "0"}
    encoded = bytearray()
    for key, value in parameters.items():
        key, value = key.encode(), value.encode()
        encoded.extend(fcgi_length(len(key)) + fcgi_length(len(value)) + key + value)
    request = fcgi_record(1, struct.pack("!HB5x", 1, 0))
    request += fcgi_record(4, encoded) + fcgi_record(4, b"") + fcgi_record(5, b"")
    output = bytearray()
    with socket.create_connection(("127.0.0.1", port), timeout=5) as stream:
        stream.sendall(request)
        for _ in range(200):
            version, kind, request_id, length, padding, _ = struct.unpack("!BBHHBB", receive(stream, 8))
            if version != 1 or request_id != 1:
                raise RuntimeError("Unexpected FastCGI response")
            content = receive(stream, length)
            receive(stream, padding)
            if kind == 6:
                output.extend(content)
            elif kind == 3:
                return output.decode("utf8")
    raise RuntimeError("FastCGI response exceeded the record limit")


def php(prefix, work, version):
    binary = prefix / "bin/php"
    if execute([binary, "-n", "-r", "echo PHP_VERSION;"]).strip() != version:
        raise RuntimeError("PHP version differs from package metadata")
    modules = execute([binary, "-n", "-m"]).lower().splitlines()
    required = ["curl", "openssl", "mbstring", "intl", "pdo_mysql", "pdo_pgsql",
                "pdo_sqlite", "zip", "sodium", "gd", "bcmath", "fileinfo"]
    if any(module not in modules for module in required):
        raise RuntimeError("PHP extensions missing: " + ", ".join(m for m in required if m not in modules))
    document = work / "project ทดสอบ"
    document.mkdir()
    script = document / "index.php"
    script.write_text("""<?php
$db = new PDO('sqlite::memory:');
$db->exec("CREATE TABLE cabin(message TEXT); INSERT INTO cabin VALUES('สวัสดี');");
header('Content-Type: application/json');
echo json_encode(['version'=>PHP_VERSION, 'message'=>$db->query('SELECT message FROM cabin')->fetchColumn()], JSON_UNESCAPED_UNICODE);
""", encoding="utf8")
    port = free_port()
    configuration = work / "php-fpm.conf"
    configuration.write_text(f"""[global]
daemonize = no
error_log = {work / 'fpm.log'}
[www]
listen = 127.0.0.1:{port}
listen.allowed_clients = 127.0.0.1
pm = ondemand
pm.max_children = 2
catch_workers_output = yes
clear_env = no
""")
    ini = work / "php.ini"
    ini.write_text("date.timezone=UTC\nmemory_limit=128M\n")
    scan = work / "ini-scan"
    scan.mkdir()
    environment = {**os.environ, "PHPRC": str(ini), "PHP_INI_SCAN_DIR": str(scan)}
    with server([prefix / "sbin/php-fpm", "-F", "-y", configuration], work, environment) as process:
        response = ready(process, lambda: fastcgi(port, script))
        if version not in response or "สวัสดี" not in response:
            raise RuntimeError(f"Unexpected PHP-FPM/SQLite response: {response}")
    return ["exact PHP version", "required extensions", "FastCGI readiness",
            "PHP-FPM response", "SQLite insert/select", "Unicode/spaced project path"]


def postgres(prefix, work, version):
    binary = prefix / "bin"
    if version not in execute([binary / "postgres", "--version"]):
        raise RuntimeError("PostgreSQL version differs from package metadata")
    admin_password, project_password = password(), password()
    secret = work / "init.password"
    secret.write_text(admin_password)
    secret.chmod(0o600)
    data = work / "data"
    execute([binary / "initdb", "-D", data, "-U", "cabin_admin", "--auth=scram-sha-256",
             "--encoding=UTF8", "--locale=C", f"--pwfile={secret}"])
    secret.unlink()
    port = free_port()
    base = [f"--host=127.0.0.1", f"--port={port}", "--no-password"]
    admin = {**os.environ, "PGPASSWORD": admin_password, "PGSSLMODE": "disable"}
    project = {**os.environ, "PGPASSWORD": project_password, "PGSSLMODE": "disable"}

    def query(database, sql, *, owner=False):
        return execute([binary / "psql", *base, f"--username={'cabin_admin' if owner else 'cabin_user'}",
                        f"--dbname={database}", "-X", "--set=ON_ERROR_STOP=1", "--tuples-only"],
                       env=admin if owner else project, sql=sql)

    with server([binary / "postgres", "-D", data, "-h", "127.0.0.1", "-p", str(port),
                 "-c", "unix_socket_directories="], work) as process:
        ready(process, lambda: query("postgres", "SELECT 1;", owner=True))
        query("postgres", f"CREATE ROLE cabin_user LOGIN PASSWORD '{project_password}';"
              "CREATE DATABASE cabin_smoke OWNER cabin_user; CREATE DATABASE cabin_restored OWNER cabin_user;", owner=True)
        query("cabin_smoke", "CREATE TABLE cabin(message TEXT); INSERT INTO cabin VALUES('hello database');")
        if "hello database" not in query("cabin_smoke", "SELECT message FROM cabin;"):
            raise RuntimeError("PostgreSQL read/write failed")
        dump = work / "database.dump"
        with dump.open("w") as output:
            execute([binary / "pg_dump", *base, "--username=cabin_user", "--dbname=cabin_smoke",
                     "--no-owner", "--no-acl"], env=project, stdout=output)
        query("cabin_restored", dump.read_text())
        if "hello database" not in query("cabin_restored", "SELECT message FROM cabin;"):
            raise RuntimeError("PostgreSQL restored data differs")
        execute([binary / "pg_ctl", "stop", "-D", data, "-m", "fast", "-w"])
    return ["exact PostgreSQL version", "SCRAM bootstrap", "loopback readiness",
            "separate project account", "insert/select", "logical dump/restore", "graceful shutdown"]


def mariadb(prefix, work, version):
    # Upstream mariadb-install-db splits its basedir search list on spaces.
    # Keep the actual runtime and data in Unicode paths, and give the script a
    # private ASCII alias. Never move the user's files to work around this.
    with tempfile.TemporaryDirectory(prefix="sc-runtime-", dir="/tmp") as directory:
        alias = Path(directory) / "runtime"
        alias.symlink_to(prefix, target_is_directory=True)
        return mariadb_at(alias, work, version)


def mariadb_at(prefix, work, version):
    binary = prefix / "bin"
    if version not in execute([binary / "mariadbd", "--version"]):
        raise RuntimeError("MariaDB version differs from package metadata")
    admin_password, project_password = password(), password()
    data = work / "data"
    initializer = prefix / "scripts/mariadb-install-db"
    execute([initializer, "--no-defaults", f"--basedir={prefix}", f"--datadir={data}", "--auth-root-authentication-method=normal", "--skip-test-db"])
    bootstrap = work / "bootstrap.sql"
    bootstrap.write_text(f"ALTER USER 'root'@'localhost' IDENTIFIED BY '{admin_password}';\n"
                         f"CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '{admin_password}';\n"
                         f"ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '{admin_password}';\n"
                         "GRANT ALL ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;\n")
    bootstrap.chmod(0o600)
    configs = {}
    for user, value in [("root", admin_password), ("cabin_user", project_password)]:
        config = work / f"{user}.cnf"
        config.write_text(f"[client]\npassword={value}\n")
        config.chmod(0o600)
        configs[user] = config
    port = free_port()

    def arguments(user):
        return [f"--defaults-file={configs[user]}", "--host=127.0.0.1", f"--port={port}", f"--user={user}"]

    def query(database, sql, *, owner=False):
        return execute([binary / "mariadb", *arguments("root" if owner else "cabin_user"), database], sql=sql)

    with tempfile.TemporaryDirectory(prefix="sc-socket-") as socket_directory, server([binary / "mariadbd", "--no-defaults", f"--basedir={prefix}", f"--datadir={data}", f"--port={port}",
                 "--bind-address=127.0.0.1", "--skip-name-resolve", f"--socket={Path(socket_directory) / 'db.sock'}",
                 f"--init-file={bootstrap}"], work) as process:
        ready(process, lambda: query("mysql", "SELECT 1;", owner=True))
        bootstrap.unlink()
        query("mysql", "CREATE DATABASE cabin_smoke; CREATE DATABASE cabin_restored;"
              f"CREATE USER 'cabin_user'@'127.0.0.1' IDENTIFIED BY '{project_password}';"
              "GRANT ALL ON cabin_smoke.* TO 'cabin_user'@'127.0.0.1';"
              "GRANT ALL ON cabin_restored.* TO 'cabin_user'@'127.0.0.1';", owner=True)
        query("cabin_smoke", "CREATE TABLE cabin(message TEXT); INSERT INTO cabin VALUES('hello database');")
        if "hello database" not in query("cabin_smoke", "SELECT message FROM cabin;"):
            raise RuntimeError("MariaDB read/write failed")
        dump = work / "database.dump"
        with dump.open("w") as output:
            execute([binary / "mariadb-dump", *arguments("cabin_user"), "--single-transaction",
                     "--skip-lock-tables", "cabin_smoke"], stdout=output)
        query("cabin_restored", dump.read_text())
        if "hello database" not in query("cabin_restored", "SELECT message FROM cabin;"):
            raise RuntimeError("MariaDB restored data differs")
        query("mysql", "SHUTDOWN;", owner=True)
        process.wait(timeout=15)
    return ["exact MariaDB version", "authenticated bootstrap", "loopback readiness",
            "separate project account", "insert/select", "logical dump/restore", "graceful shutdown"]


def verify(prefix, component, version):
    if os.name == "nt":
        raise RuntimeError("This acceptance helper is for Unix native packages")
    with tempfile.TemporaryDirectory(prefix="stackcabin runtime ทดสอบ ") as directory:
        checks = {"php": php, "postgres": postgres, "mariadb": mariadb}[component](prefix, Path(directory), version)
    return {"component": component, "version": version, "result": "passed", "checks": checks}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--component", required=True, choices=["php", "postgres", "mariadb"])
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.prefix.resolve(), args.component, args.version), ensure_ascii=False))
