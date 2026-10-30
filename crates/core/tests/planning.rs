use stackcabin_core::{models::*, project, AppCore};
use std::{path::Path, sync::Arc};
use tempfile::TempDir;

fn core(temp: &TempDir) -> AppCore {
    AppCore::new(temp.path().join("app-data"), Arc::new(|_| {})).unwrap()
}

#[test]
fn every_starter_can_be_previewed_without_creating_or_trusting_a_project() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    for preset in [
        Preset::Static,
        Preset::Php,
        Preset::Laravel,
        Preset::Node,
        Preset::Express,
        Preset::Vue,
        Preset::React,
        Preset::Nest,
        Preset::Next,
    ] {
        let plan = core.project_plan(None, preset, None).unwrap();
        assert_eq!(
            plan.requirements
                .iter()
                .filter(|r| r.component == "caddy")
                .count(),
            1
        );
        assert!(plan.requirements.iter().all(|r| !r.installed));
        assert!(!plan.processes.is_empty());
    }
    assert!(core.store.projects().unwrap().is_empty());
    for folder in ["runtimes", "downloads", "staging", "backups", "services"] {
        assert_eq!(
            std::fs::read_dir(core.store.root.join(folder))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn import_preview_reads_lockfiles_without_executing_package_scripts_or_changing_source() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let root = temp.path().join("นำเข้า ทดสอบ");
    std::fs::create_dir(&root).unwrap();
    let package = br#"{"scripts":{"dev":"node server.js","postinstall":"node -e \"require('fs').writeFileSync('EXECUTED','bad')\""}}"#;
    std::fs::write(root.join("package.json"), package).unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    let spec = project::detect(&root).unwrap();
    let plan = core
        .project_plan(Some(&root), spec.preset.clone(), Some(spec))
        .unwrap();
    assert_eq!(plan.commands.len(), 1);
    assert_eq!(plan.commands[0].tool, "npm");
    assert_eq!(plan.commands[0].args, ["ci"]);
    assert!(!root.join("EXECUTED").exists());
    assert!(!root.join("stackcabin.json").exists());
    assert_eq!(std::fs::read(root.join("package.json")).unwrap(), package);
    assert!(core.store.projects().unwrap().is_empty());
}

#[test]
fn preview_retains_detected_pnpm_and_yarn_without_duplicate_tools() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    for (manager, lock) in [("pnpm", "pnpm-lock.yaml"), ("yarn", "yarn.lock")] {
        let root = temp.path().join(manager);
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^6"}}"#,
        )
        .unwrap();
        std::fs::write(root.join(lock), "").unwrap();
        let spec = project::detect(&root).unwrap();
        let plan = core
            .project_plan(Some(&root), spec.preset.clone(), Some(spec))
            .unwrap();
        assert_eq!(plan.commands[0].tool, manager);
        assert_eq!(plan.commands[0].args, ["install"]);
        assert_eq!(
            plan.requirements
                .iter()
                .filter(|r| r.component == manager)
                .count(),
            1
        );
    }
}

#[test]
fn preview_reports_an_unavailable_pin_without_selecting_a_different_version() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let mut spec = project::default_spec("missing", Preset::Node);
    spec.runtimes[0].version = "999.0.0".into();
    let plan = core.project_plan(None, Preset::Node, Some(spec)).unwrap();
    let node = plan
        .requirements
        .iter()
        .find(|r| r.component == "node")
        .unwrap();
    assert_eq!(node.version, "999.0.0");
    assert!(node.artifact_id.is_none());
    assert!(!node.installed);
    assert_eq!(node.download_bytes, 0);
    assert!(core
        .project_plan(Some(Path::new("missing-folder")), Preset::Node, None)
        .is_err());
}

#[test]
fn laravel_preview_explains_generated_lockfile_choices_and_keeps_both_processes() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let plan = core.project_plan(None, Preset::Laravel, None).unwrap();
    assert_eq!(plan.commands.len(), 3);
    assert_eq!(plan.commands[0].tool, "composer");
    assert_eq!(plan.commands[0].args[2], "${LARAVEL_DESTINATION}");
    assert_eq!(plan.commands[1].args, ["ci"]);
    assert_eq!(
        plan.commands[1].condition.as_deref(),
        Some("generated-lockfile")
    );
    assert_eq!(plan.commands[2].args, ["install"]);
    assert_eq!(
        plan.commands[2].condition.as_deref(),
        Some("generated-no-lockfile")
    );
    assert_eq!(plan.processes.len(), 2);
}
