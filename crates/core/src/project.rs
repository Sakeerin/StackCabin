use crate::{
    models::*,
    store::{atomic_write, safe_relative, Store},
};
use anyhow::{Context, Result};
use std::{collections::BTreeMap, path::Path};

pub fn detect(path: &Path) -> Result<ProjectSpec> {
    let root = dunce::canonicalize(path).context("Project folder does not exist")?;
    anyhow::ensure!(root.is_dir(), "Choose a project folder");
    let name = root
        .file_name()
        .context("Choose a named project directory")?
        .to_string_lossy()
        .to_string();
    if root.join("stackcabin.json").exists() {
        let spec: ProjectSpec =
            serde_json::from_slice(&std::fs::read(root.join("stackcabin.json"))?)?;
        validate_spec(&spec)?;
        return Ok(spec);
    }
    let package = read_json(&root.join("package.json"))?;
    let composer = read_json(&root.join("composer.json"))?;
    let has = |key: &str| {
        package.as_ref().is_some_and(|p| {
            p["dependencies"][key].is_string() || p["devDependencies"][key].is_string()
        })
    };
    let preset = if composer
        .as_ref()
        .is_some_and(|c| c["require"]["laravel/framework"].is_string())
        || root.join("artisan").exists()
    {
        Preset::Laravel
    } else if has("next") {
        Preset::Next
    } else if has("@nestjs/core") {
        Preset::Nest
    } else if has("vue") {
        Preset::Vue
    } else if has("react") {
        Preset::React
    } else if has("express") {
        Preset::Express
    } else if package.is_some() {
        Preset::Node
    } else if composer.is_some() || root.join("index.php").exists() {
        Preset::Php
    } else {
        Preset::Static
    };
    let mut spec = default_spec(&name, preset);
    if let Some(package) = package {
        let manager = if root.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if root.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm"
        };
        for process in &mut spec.processes {
            if process.tool == "npm" {
                process.tool = manager.into();
                if spec.preset == Preset::Node || spec.preset == Preset::Express {
                    if package["scripts"]["dev"].is_string() {
                        process.args = vec!["run".into(), "dev".into()];
                    } else if package["scripts"]["start"].is_string() {
                        process.args = vec!["run".into(), "start".into()];
                    } else {
                        process.tool = "node".into();
                        process.args = vec![package["main"].as_str().unwrap_or("server.js").into()];
                    }
                }
            }
        }
        if spec.preset == Preset::Laravel && !package["scripts"]["dev"].is_string() {
            spec.runtimes.retain(|r| r.component != "node");
            spec.processes.retain(|p| p.name != "vite");
        }
    } else if spec.preset == Preset::Laravel {
        spec.runtimes.retain(|r| r.component != "node");
        spec.processes.retain(|p| p.name != "vite");
    }
    Ok(spec)
}

fn read_json(path: &Path) -> Result<Option<serde_json::Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(
        bytes.len() < 4 * 1024 * 1024,
        "Project manifest is too large"
    );
    Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
        format!("Invalid JSON in {}", path.display())
    })?))
}

pub fn default_spec(name: &str, preset: Preset) -> ProjectSpec {
    let php = matches!(preset, Preset::Php | Preset::Laravel);
    let mut runtimes = if preset == Preset::Static {
        vec![]
    } else {
        vec![RuntimeSelection {
            component: if php { "php" } else { "node" }.into(),
            version: if php { "8.5" } else { "24" }.into(),
        }]
    };
    if preset == Preset::Laravel {
        runtimes.push(RuntimeSelection {
            component: "node".into(),
            version: "24".into(),
        });
    }
    let (tool, args) = match preset {
        Preset::Static => ("static", vec![]),
        Preset::Php | Preset::Laravel => ("php-web", vec![]),
        Preset::Vue | Preset::React => (
            "npm",
            vec![
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "${PORT}",
                "--strictPort",
            ],
        ),
        Preset::Next => (
            "npm",
            vec![
                "run",
                "dev",
                "--",
                "--hostname",
                "127.0.0.1",
                "--port",
                "${PORT}",
            ],
        ),
        Preset::Nest => ("npm", vec!["run", "start:dev"]),
        _ => ("npm", vec!["run", "dev"]),
    };
    let mut processes = vec![ProcessSpec {
        name: "web".into(),
        tool: tool.into(),
        args: args.into_iter().map(String::from).collect(),
        cwd: ".".into(),
        port: Some(3000),
        health_path: Some("/".into()),
    }];
    if preset == Preset::Laravel {
        processes.push(ProcessSpec {
            name: "vite".into(),
            tool: "npm".into(),
            args: [
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "${PORT}",
                "--strictPort",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            cwd: ".".into(),
            port: Some(5173),
            health_path: Some("/".into()),
        });
    }
    ProjectSpec {
        schema_version: 1,
        name: name.into(),
        preset,
        runtimes,
        processes,
        environment: BTreeMap::new(),
        database: None,
    }
}

pub fn validate_spec(spec: &ProjectSpec) -> Result<()> {
    anyhow::ensure!(
        spec.schema_version == 1,
        "Unsupported project schema version"
    );
    anyhow::ensure!(
        !spec.name.trim().is_empty() && spec.name.len() <= 160,
        "Project name must be 1–160 characters"
    );
    anyhow::ensure!(
        spec.processes.len() <= 16,
        "A project can have at most 16 processes"
    );
    let mut components = std::collections::HashSet::new();
    for runtime in &spec.runtimes {
        anyhow::ensure!(
            ["php", "node"].contains(&runtime.component.as_str())
                && components.insert(&runtime.component),
            "Choose at most one PHP and one Node.js version per project"
        );
        anyhow::ensure!(
            !runtime.version.is_empty()
                && runtime.version.len() <= 32
                && runtime
                    .version
                    .split('.')
                    .all(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit())),
            "Invalid runtime version"
        );
    }
    if let Some(database) = &spec.database {
        if matches!(database.engine, DatabaseEngine::Sqlite) {
            safe_relative(&database.name)?;
        } else {
            anyhow::ensure!(
                [&database.name, &database.username]
                    .iter()
                    .all(|name| !name.is_empty()
                        && name.len() <= 63
                        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                    && database.port >= 1024,
                "Invalid managed database binding"
            );
        }
    }
    let mut names = std::collections::HashSet::new();
    for process in &spec.processes {
        anyhow::ensure!(
            !process.name.is_empty() && names.insert(&process.name),
            "Process names must be unique"
        );
        anyhow::ensure!(
            ["static", "php-web", "node", "npm", "pnpm", "yarn", "php", "composer"]
                .contains(&process.tool.as_str()),
            "Unsupported process tool: {}",
            process.tool
        );
        safe_relative(&process.cwd)?;
        if let Some(path) = &process.health_path {
            anyhow::ensure!(
                path.starts_with('/')
                    && !path.starts_with("//")
                    && path.len() <= 2048
                    && !path.chars().any(char::is_control),
                "Health path must be an absolute URL path"
            );
        }
        anyhow::ensure!(
            process.port.is_none_or(|p| p >= 1024),
            "Use unprivileged ports (1024+)"
        );
        anyhow::ensure!(
            process.args.len() < 256
                && process
                    .args
                    .iter()
                    .all(|a| !a.contains('\0') && a.len() < 32768),
            "Invalid process arguments"
        );
    }
    for key in spec.environment.keys() {
        anyhow::ensure!(
            !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "Invalid environment variable name"
        );
        anyhow::ensure!(
            ![
                "PATH",
                "LD_PRELOAD",
                "LD_LIBRARY_PATH",
                "DYLD_INSERT_LIBRARIES",
                "NODE_OPTIONS"
            ]
            .contains(&key.to_ascii_uppercase().as_str()),
            "Reserved environment variable: {key}"
        );
    }
    Ok(())
}

pub fn register(store: &Store, path: &Path, spec: ProjectSpec, trusted: bool) -> Result<Project> {
    validate_spec(&spec)?;
    let path = dunce::canonicalize(path)?;
    anyhow::ensure!(path.is_dir(), "Project folder does not exist");
    let text = path.to_string_lossy().to_string();
    anyhow::ensure!(
        !store.projects()?.iter().any(|p| p.path == text),
        "This folder is already registered"
    );
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        path: text,
        spec,
        trusted,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    write_spec(&project)?;
    store.save_project(&project)?;
    Ok(project)
}

pub fn write_spec(project: &Project) -> Result<()> {
    validate_spec(&project.spec)?;
    atomic_write(
        &Path::new(&project.path).join("stackcabin.json"),
        &serde_json::to_vec_pretty(&project.spec)?,
    )
}

pub fn create_files(path: &Path, name: &str, preset: &Preset) -> Result<()> {
    anyhow::ensure!(
        !path.exists(),
        "Destination already exists; choose a new folder"
    );
    safe_relative(name)?;
    anyhow::ensure!(
        !name.contains('/') && !name.trim().is_empty(),
        "Choose a single folder name"
    );
    std::fs::create_dir_all(path)?;
    let result = (|| -> Result<()> {
        let write = |relative: &str, body: &str| -> Result<()> {
            let file = path.join(relative);
            std::fs::create_dir_all(file.parent().unwrap())?;
            std::fs::write(file, body)?;
            Ok(())
        };
        let package_name = slug(name);
        let welcome="<style>body{font:18px system-ui;margin:12vh auto;max-width:720px;padding:32px;background:#f6f6f0;color:#143f35}small{letter-spacing:.15em}h1{font-size:64px;letter-spacing:-3px}a{color:inherit}</style><small>STACKCABIN · LOCAL WORKSPACE</small><h1>You're ready to build.</h1><p>Your development stack is up and running.</p>";
        match preset {
            Preset::Static => write("index.html",&format!("<!doctype html><html><meta charset=\"utf-8\"><title>StackCabin</title>{welcome}</html>"))?,
            Preset::Php => write("index.php",&format!("<!doctype html><meta charset=\"utf-8\">{welcome}<p>PHP <?= htmlspecialchars(PHP_VERSION) ?></p>"))?,
            Preset::Laravel => {
                // Composer creates Laravel in the explicit Prepare step; no remote code executes during the wizard.
                write(".stackcabin-laravel-pending","Laravel 12 will be created by Composer when you choose Install dependencies.\n")?;
            },
            Preset::Node => {
                write("package.json",&serde_json::to_string_pretty(&serde_json::json!({"name":package_name,"private":true,"type":"module","scripts":{"dev":"node --watch server.mjs","start":"node server.mjs"}}))?)?;
                write("server.mjs",&format!("import http from 'node:http';\nhttp.createServer((req,res)=>{{res.setHeader('Content-Type','text/html; charset=utf-8');res.end({});}}).listen(Number(process.env.PORT || 3000),'127.0.0.1',()=>console.log('Ready on http://127.0.0.1:'+process.env.PORT));\n",serde_json::to_string(welcome)?))?;
            },
            Preset::Express => {
                write_package(path,&package_name,serde_json::json!({"express":"^5.1.0"}),serde_json::json!({}),serde_json::json!({"dev":"node --watch server.mjs","start":"node server.mjs"}))?;
                write("server.mjs",&format!("import express from 'express';\nconst app=express();\napp.get('/',(req,res)=>res.send({}));\napp.listen(Number(process.env.PORT||3000),'127.0.0.1');\n",serde_json::to_string(welcome)?))?;
            },
            Preset::React | Preset::Vue => {
                let react=*preset==Preset::React;
                write_package(path,&package_name,if react {serde_json::json!({"react":"^19.1.0","react-dom":"^19.1.0"})} else {serde_json::json!({"vue":"^3.5.0"})},if react {serde_json::json!({"vite":"^6.3.5","@vitejs/plugin-react":"^4.4.0"})} else {serde_json::json!({"vite":"^6.3.5","@vitejs/plugin-vue":"^5.2.0"})},serde_json::json!({"dev":"vite","build":"vite build","preview":"vite preview --host 127.0.0.1"}))?;
                write("index.html",&format!("<!doctype html><html><meta charset=\"utf-8\"><title>StackCabin</title><div id=\"root\"></div><script type=\"module\" src=\"/src/main.{}\"></script></html>",if react {"jsx"} else {"js"}))?;
                write("vite.config.js",if react {"import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()]});"} else {"import {defineConfig} from 'vite';import vue from '@vitejs/plugin-vue';export default defineConfig({plugins:[vue()]});"})?;
                if react { write("src/main.jsx","import React from 'react';import {createRoot} from 'react-dom/client';import './style.css';createRoot(document.getElementById('root')).render(<main><small>STACKCABIN · REACT</small><h1>You're ready to build.</h1><p>Edit src/main.jsx and save to see your changes.</p></main>);")?; }
                else { write("src/main.js","import {createApp} from 'vue';import App from './App.vue';import './style.css';createApp(App).mount('#root');")?; write("src/App.vue","<template><main><small>STACKCABIN · VUE</small><h1>You're ready to build.</h1><p>Edit src/App.vue and save to see your changes.</p></main></template>")?; }
                write("src/style.css","body{font:18px system-ui;background:#f6f6f0;color:#143f35;margin:14vh auto;max-width:760px;padding:32px}small{letter-spacing:.15em}h1{font-size:64px;letter-spacing:-3px}")?;
            },
            Preset::Next => {
                write_package(path,&package_name,serde_json::json!({"next":"^16.0.0","react":"^19.2.0","react-dom":"^19.2.0"}),serde_json::json!({}),serde_json::json!({"dev":"next dev","build":"next build","start":"next start --hostname 127.0.0.1"}))?;
                write("app/layout.jsx","export default function Layout({children}){return <html lang=\"en\"><body style={{fontFamily:'system-ui',background:'#f6f6f0',color:'#143f35',padding:'12vh 10vw'}}>{children}</body></html>}")?;
                write("app/page.jsx","export default function Page(){return <main><small>STACKCABIN · NEXT.JS</small><h1 style={{fontSize:64}}>You're ready to build.</h1><p>Edit app/page.jsx and save.</p></main>}")?;
            },
            Preset::Nest => {
                write_package(path,&package_name,serde_json::json!({"@nestjs/common":"^11.0.0","@nestjs/core":"^11.0.0","@nestjs/platform-express":"^11.0.0","reflect-metadata":"^0.2.2","rxjs":"^7.8.2"}),serde_json::json!({"@nestjs/cli":"^11.0.0","@types/node":"^22.15.0","typescript":"~5.8.3"}),serde_json::json!({"start:dev":"nest start --watch","build":"nest build","start":"node dist/main.js"}))?;
                // Nest uses CommonJS; remove package type from this template.
                let mut package:serde_json::Value=serde_json::from_slice(&std::fs::read(path.join("package.json"))?)?; package.as_object_mut().unwrap().remove("type"); write("package.json",&serde_json::to_string_pretty(&package)?)?;
                write("tsconfig.json",r#"{"compilerOptions":{"module":"commonjs","target":"ES2021","experimentalDecorators":true,"emitDecoratorMetadata":true,"esModuleInterop":true,"outDir":"dist","skipLibCheck":true,"strict":true}}"#)?;
                write("nest-cli.json",r#"{"collection":"@nestjs/schematics","sourceRoot":"src"}"#)?;
                write("src/main.ts","import 'reflect-metadata';import {NestFactory} from '@nestjs/core';import {Module,Controller,Get} from '@nestjs/common';@Controller()class AppController{@Get()hello(){return {message:'Your NestJS workspace is ready.'}}}@Module({controllers:[AppController]})class AppModule{}async function bootstrap(){const app=await NestFactory.create(AppModule);await app.listen(Number(process.env.PORT||3000),'127.0.0.1')}void bootstrap();")?;
            }
        }
        write(
            ".gitignore",
            "node_modules/\nvendor/\n.env\n.env.*\n.next/\ndist/\n.stackcabin-*.tmp\n",
        )?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(path);
    }
    result
}

fn write_package(
    path: &Path,
    name: &str,
    dependencies: serde_json::Value,
    dev: serde_json::Value,
    scripts: serde_json::Value,
) -> Result<()> {
    std::fs::write(
        path.join("package.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"name":name,"version":"0.1.0","private":true,"type":"module","scripts":scripts,"dependencies":dependencies,"devDependencies":dev}),
        )?,
    )?;
    Ok(())
}
pub fn slug(value: &str) -> String {
    let result = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let result = result.trim_matches('-');
    if result.is_empty() {
        "my-project".into()
    } else {
        result.into()
    }
}
