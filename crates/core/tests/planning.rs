use stackcabin_core::{models::*, project, AppCore};
use std::{path::Path, sync::Arc};
use tempfile::TempDir;

fn core(temp: &TempDir) -> AppCore {
    AppCore::new(temp.path().join("app-data"), Arc::new(|_| {})).unwrap()
}

#[test]
fn new_laravel_persists_the_reviewed_runtime_versions_without_running_setup() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let mut template = project::default_spec("preview", Preset::Laravel);
    template.runtimes[0].version = "8.4".into();
    template.runtimes[1].version = "22".into();
    let review = core
        .project_plan(None, Preset::Laravel, Some(template.clone()))
        .unwrap();
    let created = core
        .create_with_runtimes(
            temp.path(),
            "ร้าน ใหม่",
            Preset::Laravel,
            false,
            Some(template.runtimes),
        )
        .unwrap();
    let path = Path::new(&created.path);
    assert!(!created.trusted);
    assert_eq!(created.spec.name, "ร้าน ใหม่");
    assert!(path.join(".stackcabin-laravel-pending").is_file());
    assert!(!path.join("vendor").exists());
    let lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.join("stackcabin.lock.json")).unwrap()).unwrap();
    let pins = serde_json::to_value(&created.spec.runtimes).unwrap();
    assert_eq!(lock["runtimes"], pins);
    assert_eq!(
        serde_json::to_value(project::detect(path).unwrap().runtimes).unwrap(),
        pins
    );
    for (runtime, expected) in created.spec.runtimes.iter().zip(["8.4", "22"]) {
        let requirement = review
            .requirements
            .iter()
            .find(|r| r.component == runtime.component)
            .unwrap();
        assert_eq!(runtime.version, requirement.version);
        assert!(
            runtime.version == expected || runtime.version.starts_with(&format!("{expected}."))
        );
    }
}

#[test]
fn invalid_starter_selections_leave_the_destination_available_for_retry() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let selection = |component: &str, version: &str| RuntimeSelection {
        component: component.into(),
        version: version.into(),
    };
    for (preset, runtimes) in [
        (Preset::Node, vec![]),
        (
            Preset::Laravel,
            vec![selection("php", "8.5"), selection("php", "8.4")],
        ),
        (Preset::Static, vec![selection("node", "22")]),
        (Preset::React, vec![selection("php", "8.4")]),
        (Preset::Node, vec![selection("node", "latest")]),
    ] {
        assert!(core
            .create_with_runtimes(temp.path(), "retry", preset, false, Some(runtimes))
            .is_err());
        assert!(!temp.path().join("retry").exists());
        assert!(core.store.projects().unwrap().is_empty());
    }
    let created = core
        .create(temp.path(), "retry", Preset::Node, false)
        .unwrap();
    assert_eq!(created.spec.runtimes.len(), 1);
    let node = &created.spec.runtimes[0];
    assert_eq!(node.component, "node");
    assert!(node.version == "24" || node.version.starts_with("24."));
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
fn imported_dev_servers_forward_the_loopback_host_and_port_with_each_manager() {
    let temp = TempDir::new().unwrap();
    for (manager, lock) in [
        ("npm", "package-lock.json"),
        ("pnpm", "pnpm-lock.yaml"),
        ("yarn", "yarn.lock"),
    ] {
        for (dependency, host_flag) in [
            ("react", "--host"),
            ("vue", "--host"),
            ("next", "--hostname"),
            ("laravel", "--host"),
        ] {
            let root = temp.path().join(format!("{manager}-{dependency}"));
            std::fs::create_dir(&root).unwrap();
            if dependency == "laravel" {
                std::fs::write(root.join("artisan"), "").unwrap();
            }
            std::fs::write(root.join(lock), "").unwrap();
            let package = serde_json::json!({
                "scripts": { "dev": "dev-server" }, "dependencies": { (dependency): "1" }
            });
            std::fs::write(root.join("package.json"), package.to_string()).unwrap();
            let spec = project::detect(&root).unwrap();
            let process = spec.processes.iter().find(|p| p.tool == manager).unwrap();
            let mut expected = vec!["run", "dev"];
            if manager == "npm" {
                expected.push("--");
            }
            expected.extend([host_flag, "127.0.0.1", "--port", "${PORT}"]);
            if dependency != "next" {
                expected.push("--strictPort");
            }
            assert_eq!(process.args, expected, "{manager} / {dependency}");
        }
    }
}

#[test]
fn direct_node_entry_and_build_only_laravel_use_their_folders_package_manager() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    for (manager, lock, laravel, entry) in [
        ("pnpm", "pnpm-lock.yaml", false, "node"),
        ("yarn", "yarn.lock", false, "node"),
        ("pnpm", "pnpm-lock.yaml", true, "php-web"),
    ] {
        let root = temp.path().join(format!("{manager}-{entry}"));
        std::fs::create_dir(&root).unwrap();
        if laravel {
            std::fs::write(root.join("artisan"), "").unwrap();
        }
        std::fs::write(root.join(lock), "").unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"main":"index.cjs","scripts":{"build":"vite build"}}"#,
        )
        .unwrap();
        let spec = project::detect(&root).unwrap();
        let plan = core
            .project_plan(Some(&root), spec.preset.clone(), Some(spec))
            .unwrap();
        assert_eq!(plan.processes.len(), 1);
        assert_eq!(plan.processes[0].tool, entry);
        assert_eq!(plan.commands.len(), 1);
        assert_eq!(plan.commands[0].tool, manager);
        assert_eq!(plan.commands[0].args, ["install"]);
        assert!(plan.requirements.iter().any(|r| r.component == manager));
        assert!(plan.requirements.iter().any(|r| r.component == "node"));
    }
}

#[test]
fn importing_keeps_the_runtime_versions_reviewed_for_each_language() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let root = temp.path().join("ร้านค้า ตัวอย่าง");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("artisan"), "").unwrap();
    std::fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
    let mut spec = project::detect(&root).unwrap();
    for runtime in &mut spec.runtimes {
        runtime.version = match runtime.component.as_str() {
            "php" => "8.4",
            "node" => "22",
            other => panic!("Unexpected runtime {other}"),
        }
        .into();
    }
    let plan = core
        .project_plan(Some(&root), Preset::Laravel, Some(spec.clone()))
        .unwrap();
    let saved = core.import(&root, spec, false).unwrap();
    assert!(!saved.trusted);
    let manifest = project::detect(&root).unwrap();
    let lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("stackcabin.lock.json")).unwrap()).unwrap();
    let pins = serde_json::to_value(&saved.spec.runtimes).unwrap();
    assert_eq!(serde_json::to_value(manifest.runtimes).unwrap(), pins);
    assert_eq!(lock["runtimes"], pins);
    for (component, branch) in [("php", "8.4"), ("node", "22")] {
        let reviewed = plan
            .requirements
            .iter()
            .find(|r| r.component == component)
            .unwrap();
        let saved = saved
            .spec
            .runtimes
            .iter()
            .find(|r| r.component == component)
            .unwrap();
        assert!(saved.version == branch || saved.version.starts_with(&format!("{branch}.")));
        assert_eq!(reviewed.version, saved.version);
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
