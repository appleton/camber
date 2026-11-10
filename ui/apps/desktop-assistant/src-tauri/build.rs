fn main() {
    ensure_debug_sidecar_placeholder();
    tauri_build::build();
}

fn ensure_debug_sidecar_placeholder() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }

    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };

    let binary_dir = std::path::Path::new(&manifest_dir).join("binaries");
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    std::fs::create_dir_all(&binary_dir).expect("failed to create Tauri sidecar binary dir");
    write_debug_sidecar_placeholder(&binary_dir, &format!("camber-helper-{target}{extension}"));
    write_debug_sidecar_placeholder(
        &binary_dir,
        &format!("camber-mlx-sidecar-{target}{extension}"),
    );
    write_debug_resource_placeholder(&binary_dir, "default.metallib");
    write_debug_resource_placeholder(&binary_dir, "mlx.metallib");
}

fn write_debug_sidecar_placeholder(binary_dir: &std::path::Path, file_name: &str) {
    let path = binary_dir.join(file_name);
    if path.exists() {
        return;
    }

    std::fs::write(&path, []).expect("failed to create debug sidecar placeholder");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("failed to mark debug sidecar placeholder executable");
    }
}

fn write_debug_resource_placeholder(binary_dir: &std::path::Path, file_name: &str) {
    let path = binary_dir.join(file_name);
    if path.exists() {
        return;
    }

    std::fs::write(&path, []).expect("failed to create debug sidecar resource placeholder");
}
