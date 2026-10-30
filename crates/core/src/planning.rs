use crate::models::*;
use std::path::Path;

pub const LARAVEL_DESTINATION: &str = "${LARAVEL_DESTINATION}";

pub fn laravel_arguments(destination: &str) -> Vec<String> {
    [
        "create-project",
        "laravel/laravel:^12.0",
        destination,
        "--no-interaction",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

pub fn composer_arguments() -> Vec<String> {
    vec!["install".into(), "--no-interaction".into()]
}

pub fn node_command(spec: &ProjectSpec, locked: bool) -> PreparationCommand {
    let tool = spec
        .processes
        .iter()
        .find(|p| ["npm", "pnpm", "yarn"].contains(&p.tool.as_str()))
        .map(|p| p.tool.as_str())
        .unwrap_or("npm");
    PreparationCommand {
        tool: tool.into(),
        args: vec![if tool == "npm" && locked {
            "ci"
        } else {
            "install"
        }
        .into()],
        condition: None,
    }
}

/// Inspect files without creating a project, installing tools or running scripts.
/// A missing path describes the files produced by the selected built-in starter.
pub fn commands(spec: &ProjectSpec, path: Option<&Path>) -> Vec<PreparationCommand> {
    let pending = path.map_or(spec.preset == Preset::Laravel, |root| {
        root.join(".stackcabin-laravel-pending").is_file()
    });
    let mut result = vec![];
    if pending {
        result.push(PreparationCommand {
            tool: "composer".into(),
            args: laravel_arguments(LARAVEL_DESTINATION),
            condition: None,
        });
        // The generated project's lockfile is known only after Composer finishes.
        for (locked, condition) in [
            (true, "generated-lockfile"),
            (false, "generated-no-lockfile"),
        ] {
            let mut command = node_command(spec, locked);
            command.condition = Some(condition.into());
            result.push(command);
        }
    } else {
        if path.is_some_and(|root| root.join("composer.json").is_file()) {
            result.push(PreparationCommand {
                tool: "composer".into(),
                args: composer_arguments(),
                condition: None,
            });
        }
        if path.map_or(
            !matches!(spec.preset, Preset::Static | Preset::Php),
            |root| root.join("package.json").is_file(),
        ) {
            result.push(node_command(
                spec,
                path.is_some_and(|root| root.join("package-lock.json").is_file()),
            ));
        }
    }
    result
}
