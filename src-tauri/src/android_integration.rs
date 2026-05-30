#[cfg(target_os = "android")]
use jni::objects::{JObject, JString, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};
#[cfg(target_os = "android")]
use ndk_context::android_context;
#[cfg(target_os = "android")]
use std::fs;
#[cfg(target_os = "android")]
use std::path::PathBuf;
#[cfg(target_os = "android")]
static INIT_NDK_CONTEXT: std::sync::Once = std::sync::Once::new();

#[cfg(target_os = "android")]
pub fn initialize_android(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        webview.jni_handle().exec(|env, context, _webview| {
            if let Ok(vm) = env.get_java_vm() {
                let vm_ptr = vm.get_java_vm_pointer() as *mut std::ffi::c_void;
                let context_ptr = context.as_raw() as *mut std::ffi::c_void;

                INIT_NDK_CONTEXT.call_once(|| unsafe {
                    ndk_context::initialize_android_context(vm_ptr, context_ptr);
                    log::info!("Successfully initialized ndk-context on Android.");
                });
            }
        });
    });
}

pub fn is_android_content_uri(path: &str) -> bool {
    path.starts_with("content://")
}

#[cfg(target_os = "android")]
pub fn clear_pending_android_exception(env: &mut JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

#[cfg(target_os = "android")]
pub fn map_android_jni_error(env: &mut JNIEnv<'_>, err: jni::errors::Error) -> String {
    clear_pending_android_exception(env);
    format!("Android JNI error: {}", err)
}

#[cfg(target_os = "android")]
pub fn close_android_closeable(env: &mut JNIEnv<'_>, closeable: &JObject<'_>) {
    if closeable.is_null() {
        return;
    }

    if let Err(err) = env.call_method(closeable, "close", "()V", &[]) {
        clear_pending_android_exception(env);
        log::warn!("Failed to close Android Closeable: {}", err);
    }
}

#[cfg(target_os = "android")]
pub fn get_android_cached_lut_path(uri: &str, extension: &str) -> anyhow::Result<PathBuf> {
    let vm = unsafe { jni::JavaVM::from_raw(ndk_context::android_context().vm().cast()) }
        .map_err(|e| anyhow::anyhow!("Failed to access Android JVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| anyhow::anyhow!("Failed to attach current thread: {}", e))?;

    let context = env
        .new_local_ref(unsafe {
            jni::objects::JObject::from_raw(ndk_context::android_context().context().cast())
        })
        .map_err(|e| anyhow::anyhow!(map_android_jni_error(&mut env, e)))?;

    let dirs_array_obj = env
        .call_method(&context, "getExternalMediaDirs", "()[Ljava/io/File;", &[])
        .and_then(|v| v.l())
        .map_err(|e| anyhow::anyhow!(map_android_jni_error(&mut env, e)))?;

    if dirs_array_obj.is_null() {
        return Err(anyhow::anyhow!("External media storage not available"));
    }

    let dirs_array: jni::objects::JObjectArray = dirs_array_obj.into();
    let dir_file = env
        .get_object_array_element(&dirs_array, 0)
        .map_err(|e| anyhow::anyhow!(map_android_jni_error(&mut env, e)))?;

    let path_jstring = env
        .call_method(&dir_file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|v| v.l())
        .map_err(|e| anyhow::anyhow!(map_android_jni_error(&mut env, e)))?;

    let root_path_str: String = env
        .get_string(&path_jstring.into())
        .map_err(|e| anyhow::anyhow!(map_android_jni_error(&mut env, e)))?
        .into();

    let hash = blake3::hash(uri.as_bytes());

    let mut path = PathBuf::from(root_path_str);
    path.push(".lut_cache");

    if !path.exists() {
        fs::create_dir_all(&path)?;
    }

    path.push(format!("{}.{}", &hash.to_hex()[..16], extension));
    Ok(path)
}

#[cfg(target_os = "android")]
pub fn get_android_content_resolver<'local>(
    env: &mut JNIEnv<'local>,
) -> Result<JObject<'local>, String> {
    let context = env
        .new_local_ref(unsafe { JObject::from_raw(android_context().context().cast()) })
        .map_err(|e| map_android_jni_error(env, e))?;

    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(env, e))?;

    if resolver.is_null() {
        return Err("Android ContentResolver was null.".into());
    }

    Ok(resolver)
}

#[cfg(target_os = "android")]
pub fn parse_android_uri<'local>(
    env: &mut JNIEnv<'local>,
    uri_str: &str,
) -> Result<JObject<'local>, String> {
    let uri_string = env
        .new_string(uri_str)
        .map_err(|e| map_android_jni_error(env, e))?;

    let uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[(&uri_string).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(env, e))?;

    if uri.is_null() {
        return Err(format!("Failed to parse Android content URI: {}", uri_str));
    }

    Ok(uri)
}

#[tauri::command]
pub fn resolve_android_content_uri_name(uri_str: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let vm = unsafe { JavaVM::from_raw(android_context().vm().cast()) }
            .map_err(|e| format!("Failed to access Android JVM: {}", e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("Failed to attach current thread to Android JVM: {}", e))?;

        let resolver = get_android_content_resolver(&mut env)?;
        let uri = parse_android_uri(&mut env, uri_str)?;
        let null_obj = JObject::null();

        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    (&uri).into(),
                    (&null_obj).into(),
                    (&null_obj).into(),
                    (&null_obj).into(),
                    (&null_obj).into(),
                ],
            )
            .and_then(|value| value.l())
            .map_err(|e| map_android_jni_error(&mut env, e))?;

        if cursor.is_null() {
            return Err(format!(
                "ContentResolver query returned no cursor for URI: {}",
                uri_str
            ));
        }

        let result = (|| -> Result<String, String> {
            let moved = env
                .call_method(&cursor, "moveToFirst", "()Z", &[])
                .and_then(|value| value.z())
                .map_err(|e| map_android_jni_error(&mut env, e))?;

            if !moved {
                return Err(format!(
                    "No metadata rows found for content URI: {}",
                    uri_str
                ));
            }

            let display_name_column = env
                .get_static_field(
                    "android/provider/OpenableColumns",
                    "DISPLAY_NAME",
                    "Ljava/lang/String;",
                )
                .and_then(|value| value.l())
                .map_err(|e| map_android_jni_error(&mut env, e))?;
            let column_index = env
                .call_method(
                    &cursor,
                    "getColumnIndex",
                    "(Ljava/lang/String;)I",
                    &[(&display_name_column).into()],
                )
                .and_then(|value| value.i())
                .map_err(|e| map_android_jni_error(&mut env, e))?;

            if column_index < 0 {
                return Err(format!(
                    "DISPLAY_NAME column was unavailable for content URI: {}",
                    uri_str
                ));
            }

            let display_name_obj = env
                .call_method(
                    &cursor,
                    "getString",
                    "(I)Ljava/lang/String;",
                    &[JValue::from(column_index)],
                )
                .and_then(|value| value.l())
                .map_err(|e| map_android_jni_error(&mut env, e))?;

            if display_name_obj.is_null() {
                return Err(format!(
                    "Display name was null for content URI: {}",
                    uri_str
                ));
            }

            let display_name_java = JString::from(display_name_obj);
            let display_name = env
                .get_string(&display_name_java)
                .map_err(|e| map_android_jni_error(&mut env, e))?;

            Ok(display_name.into())
        })();

        close_android_closeable(&mut env, &cursor);
        result
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(uri_str.to_string())
    }
}

#[cfg(target_os = "android")]
pub fn read_android_content_uri(uri_str: &str) -> Result<Vec<u8>, String> {
    let vm = unsafe { JavaVM::from_raw(android_context().vm().cast()) }
        .map_err(|e| format!("Failed to access Android JVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach current thread to Android JVM: {}", e))?;

    let resolver = get_android_content_resolver(&mut env)?;
    let uri = parse_android_uri(&mut env, uri_str)?;
    let input_stream = env
        .call_method(
            &resolver,
            "openInputStream",
            "(Landroid/net/Uri;)Ljava/io/InputStream;",
            &[(&uri).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    if input_stream.is_null() {
        return Err(format!(
            "Failed to open InputStream for Android content URI: {}",
            uri_str
        ));
    }

    let result = (|| -> Result<Vec<u8>, String> {
        const BUFFER_SIZE: i32 = 8192;

        let java_buffer = env
            .new_byte_array(BUFFER_SIZE)
            .map_err(|e| map_android_jni_error(&mut env, e))?;
        let mut rust_buffer = vec![0i8; BUFFER_SIZE as usize];
        let mut bytes = Vec::new();

        loop {
            let read_count = env
                .call_method(&input_stream, "read", "([B)I", &[(&java_buffer).into()])
                .and_then(|value| value.i())
                .map_err(|e| map_android_jni_error(&mut env, e))?;

            if read_count < 0 {
                break;
            }

            if read_count == 0 {
                continue;
            }

            let read_len = read_count as usize;
            env.get_byte_array_region(&java_buffer, 0, &mut rust_buffer[..read_len])
                .map_err(|e| map_android_jni_error(&mut env, e))?;
            bytes.extend(rust_buffer[..read_len].iter().map(|byte| *byte as u8));
        }

        Ok(bytes)
    })();

    close_android_closeable(&mut env, &input_stream);
    result
}

#[cfg(target_os = "android")]
pub fn put_android_content_value_string<'local>(
    env: &mut JNIEnv<'local>,
    content_values: &JObject<'local>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let key_java = env
        .new_string(key)
        .map_err(|e| map_android_jni_error(env, e))?;
    let value_java = env
        .new_string(value)
        .map_err(|e| map_android_jni_error(env, e))?;

    env.call_method(
        content_values,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[(&key_java).into(), (&value_java).into()],
    )
    .map_err(|e| map_android_jni_error(env, e))?;

    Ok(())
}

#[cfg(target_os = "android")]
pub fn put_android_content_value_int<'local>(
    env: &mut JNIEnv<'local>,
    content_values: &JObject<'local>,
    key: &str,
    value: i32,
) -> Result<(), String> {
    let key_java = env
        .new_string(key)
        .map_err(|e| map_android_jni_error(env, e))?;
    let value_java = env
        .new_object("java/lang/Integer", "(I)V", &[JValue::from(value)])
        .map_err(|e| map_android_jni_error(env, e))?;

    env.call_method(
        content_values,
        "put",
        "(Ljava/lang/String;Ljava/lang/Integer;)V",
        &[(&key_java).into(), (&value_java).into()],
    )
    .map_err(|e| map_android_jni_error(env, e))?;

    Ok(())
}

#[cfg(target_os = "android")]
pub fn delete_android_media_store_item(
    env: &mut JNIEnv<'_>,
    resolver: &JObject<'_>,
    item_uri: &JObject<'_>,
) {
    let null_string = JObject::null();
    let null_args = JObject::null();
    if let Err(err) = env.call_method(
        resolver,
        "delete",
        "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I",
        &[item_uri.into(), (&null_string).into(), (&null_args).into()],
    ) {
        clear_pending_android_exception(env);
        log::warn!(
            "Failed to delete Android MediaStore item after write error: {}",
            err
        );
    }
}

#[cfg(target_os = "android")]
pub fn save_bytes_to_android_media_store(
    file_name: &str,
    mime_type: &str,
    relative_path: &str,
    collection_class: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let vm = unsafe { JavaVM::from_raw(android_context().vm().cast()) }
        .map_err(|e| format!("Failed to access Android JVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach current thread to Android JVM: {}", e))?;
    let resolver = get_android_content_resolver(&mut env)?;
    let content_values = env
        .new_object("android/content/ContentValues", "()V", &[])
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    put_android_content_value_string(&mut env, &content_values, "_display_name", file_name)?;
    put_android_content_value_string(&mut env, &content_values, "mime_type", mime_type)?;
    put_android_content_value_string(&mut env, &content_values, "relative_path", relative_path)?;
    put_android_content_value_int(&mut env, &content_values, "is_pending", 1)?;

    let collection_uri = env
        .get_static_field(
            collection_class,
            "EXTERNAL_CONTENT_URI",
            "Landroid/net/Uri;",
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;
    let item_uri = env
        .call_method(
            &resolver,
            "insert",
            "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
            &[(&collection_uri).into(), (&content_values).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    if item_uri.is_null() {
        return Err(format!(
            "Failed to create Android MediaStore item for {}",
            file_name
        ));
    }

    let output_stream = env
        .call_method(
            &resolver,
            "openOutputStream",
            "(Landroid/net/Uri;)Ljava/io/OutputStream;",
            &[(&item_uri).into()],
        )
        .and_then(|value| value.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    if output_stream.is_null() {
        delete_android_media_store_item(&mut env, &resolver, &item_uri);
        return Err(format!(
            "Failed to open Android MediaStore output stream for {}",
            file_name
        ));
    }

    let write_result = (|| -> Result<(), String> {
        let byte_array = env
            .byte_array_from_slice(bytes)
            .map_err(|e| map_android_jni_error(&mut env, e))?;
        env.call_method(&output_stream, "write", "([B)V", &[(&byte_array).into()])
            .map_err(|e| map_android_jni_error(&mut env, e))?;
        env.call_method(&output_stream, "flush", "()V", &[])
            .map_err(|e| map_android_jni_error(&mut env, e))?;
        Ok(())
    })();

    close_android_closeable(&mut env, &output_stream);

    if let Err(err) = write_result {
        delete_android_media_store_item(&mut env, &resolver, &item_uri);
        return Err(err);
    }

    let finalized_values = env
        .new_object("android/content/ContentValues", "()V", &[])
        .map_err(|e| map_android_jni_error(&mut env, e))?;
    put_android_content_value_int(&mut env, &finalized_values, "is_pending", 0)?;

    let null_string = JObject::null();
    let null_args = JObject::null();
    env.call_method(
        &resolver,
        "update",
        "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
        &[
            (&item_uri).into(),
            (&finalized_values).into(),
            (&null_string).into(),
            (&null_args).into(),
        ],
    )
    .map_err(|e| map_android_jni_error(&mut env, e))?;

    Ok(())
}

#[cfg(target_os = "android")]
pub fn save_image_bytes_to_android_gallery(
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<(), String> {
    save_bytes_to_android_media_store(
        file_name,
        mime_type,
        "Pictures/RapidRaw",
        "android/provider/MediaStore$Images$Media",
        bytes,
    )
}

#[cfg(target_os = "android")]
pub fn save_file_bytes_to_android_downloads(
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<(), String> {
    save_bytes_to_android_media_store(
        file_name,
        mime_type,
        "Download/RapidRaw",
        "android/provider/MediaStore$Downloads",
        bytes,
    )
}

#[cfg(target_os = "android")]
pub fn get_android_internal_library_root() -> Result<PathBuf, String> {
    let vm = unsafe { JavaVM::from_raw(android_context().vm().cast()) }
        .map_err(|e| format!("Failed to access Android JVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach current thread: {}", e))?;

    let context = env
        .new_local_ref(unsafe { JObject::from_raw(android_context().context().cast()) })
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    let dirs_array_obj = env
        .call_method(&context, "getExternalMediaDirs", "()[Ljava/io/File;", &[])
        .and_then(|v| v.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    if dirs_array_obj.is_null() {
        return Err("External media storage not available".to_string());
    }

    let dirs_array: jni::objects::JObjectArray = dirs_array_obj.into();

    let dir_file = env
        .get_object_array_element(&dirs_array, 0)
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    if dir_file.is_null() {
        return Err("Primary external media storage is null".to_string());
    }

    let path_jstring = env
        .call_method(&dir_file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|v| v.l())
        .map_err(|e| map_android_jni_error(&mut env, e))?;

    let path: String = env
        .get_string(&path_jstring.into())
        .map_err(|e| map_android_jni_error(&mut env, e))?
        .into();

    let media_path = PathBuf::from(path);
    let library_dir = media_path.join(".library");

    if !library_dir.exists() {
        fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    }
    Ok(library_dir)
}
