import groovy.json.JsonSlurper
import java.io.ByteArrayOutputStream

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

val rustlsPlatformVerifierMavenRepo: String? = try {
    val output = ByteArrayOutputStream()
    exec {
        workingDir = rootProject.projectDir
        commandLine("cargo", "metadata", "--format-version", "1", "--manifest-path", "../../Cargo.toml")
        standardOutput = output
    }
    val json = JsonSlurper().parseText(output.toString()) as Map<String, Any>
    val packages = json["packages"] as List<Map<String, Any>>
    val pkg = packages.first { it["name"] == "rustls-platform-verifier-android" }
    val manifestPath = pkg["manifest_path"] as String
    manifestPath.replace("/Cargo.toml", "") + "/maven"
} catch (e: Exception) {
    logger.warn("Could not locate rustls-platform-verifier Maven repo: ${e.message}")
    null
}

allprojects {
    repositories {
        google()
        mavenCentral()
        if (rustlsPlatformVerifierMavenRepo != null) {
            maven { url = uri(rustlsPlatformVerifierMavenRepo) }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

