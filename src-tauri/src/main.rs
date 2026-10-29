#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(feature = "e2e")]
    if stackcabin_desktop::lifecycle_e2e::run_fixture() {
        return;
    }
    stackcabin_desktop::run();
}
