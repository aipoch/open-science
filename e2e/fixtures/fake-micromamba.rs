// Windows-only native process fixture for the opt-in Electron Notebook lifecycle certification.
// It models micromamba, Python inventory, and pip process trees without network or package writes.
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{self, Command};
use std::thread;
use std::time::Duration;

fn event_path(prefix: &Path) -> PathBuf {
    prefix.join(".fake-micromamba-events.tsv")
}

fn append_event(kind: &str, prefix: &Path, descendant_pid: Option<u32>) {
    fs::create_dir_all(prefix).unwrap();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(event_path(prefix))
        .unwrap();
    writeln!(
        file,
        "{}\t{}\t{}\t{}",
        kind,
        prefix.display(),
        process::id(),
        descendant_pid
            .map(|pid| pid.to_string())
            .unwrap_or_default()
    )
    .unwrap();
}

fn argument_after(args: &[String], flag: &str) -> Option<PathBuf> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
}

fn create_fake_python(prefix: &Path) {
    fs::create_dir_all(prefix.join("conda-meta")).unwrap();
    fs::create_dir_all(prefix.join("Scripts")).unwrap();
    fs::copy(env::current_exe().unwrap(), prefix.join("python.exe")).unwrap();
    fs::copy(
        env::current_exe().unwrap(),
        prefix.join("Scripts").join("pip.exe"),
    )
    .unwrap();
}

fn run_fake_python(args: &[String]) {
    let executable = env::current_exe().unwrap();
    let is_pip_executable = executable
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("pip.exe"));
    let executable_dir = executable.parent().unwrap();
    let prefix = if is_pip_executable {
        executable_dir.parent().unwrap()
    } else {
        executable_dir
    };
    if args.iter().any(|arg| arg == "-c") {
        println!("RUNTIME\t3.13.0\twin32\tAMD64");
        if prefix.join(".fake-package-installed").exists() {
            println!("PACKAGE\te2e-ok\t1.0.0");
        }
        return;
    }
    if !is_pip_executable && !args.iter().any(|arg| arg == "pip") {
        return;
    }

    let is_cancelled_install = args.iter().any(|arg| arg == "e2e-hang");
    let descendant = if is_cancelled_install {
        Some(
            Command::new(&executable)
                .arg("--descendant")
                .spawn()
                .unwrap(),
        )
    } else {
        None
    };
    append_event(
        "package-start",
        prefix,
        descendant.as_ref().map(|child| child.id()),
    );
    if is_cancelled_install {
        thread::sleep(Duration::from_secs(90));
    } else {
        fs::write(prefix.join(".fake-package-installed"), "e2e-ok").unwrap();
        append_event("package-complete", prefix, None);
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--descendant") {
        thread::sleep(Duration::from_secs(120));
        return;
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("Python 3.13.0");
        return;
    }
    if args.iter().any(|arg| arg == "list") {
        return;
    }
    if env::current_exe().unwrap().file_name().is_some_and(|name| {
        name.eq_ignore_ascii_case("python.exe") || name.eq_ignore_ascii_case("pip.exe")
    }) {
        run_fake_python(&args);
        return;
    }
    if !args.iter().any(|arg| arg == "create") {
        return;
    }

    let prefix = argument_after(&args, "-p")
        .or_else(|| argument_after(&args, "--prefix"))
        .expect("fake micromamba create requires a prefix");
    let is_cancelled_create = args.iter().any(|arg| arg == "e2e-hang");
    let descendant = if is_cancelled_create {
        Some(
            Command::new(env::current_exe().unwrap())
                .arg("--descendant")
                .spawn()
                .unwrap(),
        )
    } else {
        None
    };
    append_event(
        "start",
        &prefix,
        descendant.as_ref().map(|child| child.id()),
    );

    if is_cancelled_create {
        thread::sleep(Duration::from_secs(90));
    } else if prefix.to_string_lossy().contains("e2e-lng") {
        thread::sleep(Duration::from_secs(65));
    }

    create_fake_python(&prefix);
    append_event("complete", &prefix, None);
}
