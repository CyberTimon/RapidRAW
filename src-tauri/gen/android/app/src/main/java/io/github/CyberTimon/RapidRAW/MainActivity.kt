package io.github.CyberTimon.RapidRAW

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val safeMarginBackgroundColor = Color.rgb(24, 24, 24)
  private var webView: WebView? = null

  // Share / Open with: files are copied off the UI thread, one intent after the other
  private val shareExecutor = Executors.newSingleThreadExecutor()
  private var inboxNoteSeq = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val rootView: View = findViewById(android.R.id.content)
    rootView.setBackgroundColor(safeMarginBackgroundColor)

    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottomPadding = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
        ime.bottom
      } else {
        systemBars.bottom
      }

      view.setPadding(
        systemBars.left,
        systemBars.top,
        systemBars.right,
        bottomPadding
      )

      insets
    }

    ViewCompat.requestApplyInsets(rootView)

    // cold start from "Share" / "Open with" (a recreated activity already handled its intent)
    if (savedInstanceState == null) {
      handleSharedIntent(intent)
    }
  }

  // the app was already running (launchMode singleTask)
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleSharedIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView

    webView.setBackgroundColor(safeMarginBackgroundColor)
    webView.fitsSystemWindows = true
    webView.settings.useWideViewPort = true

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        this@MainActivity.webView?.evaluateJavascript("window.__handleAndroidBack()", null)
      }
    })
  }

  // ---- Share → RapidRAW / Open with → RapidRAW ----------------------------------------------------------------
  // Every received file is copied to <external media dir>/.library/Imports/Shared/YYYY-MM-DD/<original name> (the
  // app's library folder; ".library" keeps it out of the gallery). An identical file already there is reused; a
  // different one with the same name gets " (1)", " (2)"… Then a note listing the copies goes to
  // <external media dir>/shared-inbox/<millis>-<n>.json (written as .tmp and renamed) and the UI is told to take it
  // (src-tauri/src/shared_import.rs, src/hooks/useSharedImports.ts). If the UI isn't loaded yet, it takes the notes
  // when it starts.

  private fun handleSharedIntent(intent: Intent?) {
    if (intent == null) return
    // reopened from the recents screen: the same intent again, already imported
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    val uris = sharedUris(intent)
    if (uris.isEmpty()) return

    @Suppress("DEPRECATION")
    val mediaDir = externalMediaDirs.firstOrNull { it != null }
    if (mediaDir == null) {
      Log.e(TAG, "No external media storage: cannot receive shared files")
      return
    }
    val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    val targetDir = File(File(File(File(mediaDir, ".library"), "Imports"), "Shared"), day)
    val inbox = File(mediaDir, INBOX_DIR)
    val context = applicationContext

    notifyUi("receiving", uris.size)
    shareExecutor.execute {
      val paths = JSONArray()
      var failed = 0
      for (uri in uris) {
        try {
          paths.put(copyShared(context, uri, targetDir).absolutePath)
        } catch (e: Exception) {
          Log.w(TAG, "Could not copy shared file " + uri, e)
          failed++
        }
      }
      try {
        writeInboxNote(inbox, paths, failed)
      } catch (e: Exception) {
        Log.e(TAG, "Could not write the shared-inbox note", e)
      }
      runOnUiThread { notifyUi("ready", paths.length()) }
    }
  }

  private fun notifyUi(state: String, count: Int) {
    webView?.evaluateJavascript(
      "window.__rapidrawSharedImports && window.__rapidrawSharedImports('" + state + "', " + count + ")",
      null
    )
  }

  private fun sharedUris(intent: Intent): List<Uri> {
    val uris = LinkedHashSet<Uri>()
    when (intent.action) {
      Intent.ACTION_SEND -> streamExtra(intent)?.let { uris.add(it) }
      Intent.ACTION_SEND_MULTIPLE -> uris.addAll(streamListExtra(intent))
      Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
      else -> return emptyList()
    }
    if (uris.isEmpty()) {
      intent.clipData?.let { clip ->
        for (i in 0 until clip.itemCount) {
          clip.getItemAt(i).uri?.let { uris.add(it) }
        }
      }
    }
    return uris.filter { it.scheme == "content" || it.scheme == "file" }
  }

  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    }

  private fun streamListExtra(intent: Intent): List<Uri> {
    val list: List<Uri>? = if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
    }
    return list?.filterNotNull() ?: emptyList()
  }

  private fun openShared(context: Context, uri: Uri): InputStream =
    if (uri.scheme == "file") {
      FileInputStream(File(uri.path ?: throw IOException("Empty file URI")))
    } else {
      context.contentResolver.openInputStream(uri) ?: throw IOException("Cannot open " + uri)
    }

  /** Name and size (-1 if unknown) the sending app gives for the file. */
  private fun describeShared(context: Context, uri: Uri): Pair<String?, Long> {
    if (uri.scheme == "file") {
      val f = File(uri.path ?: "")
      return Pair(f.name, if (f.isFile) f.length() else -1L)
    }
    var name: String? = null
    var size = -1L
    try {
      context.contentResolver.query(
        uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null
      )?.use { c ->
        if (c.moveToFirst()) {
          val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val si = c.getColumnIndex(OpenableColumns.SIZE)
          if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
          if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "Could not query " + uri, e)
    }
    return Pair(name ?: uri.lastPathSegment, size)
  }

  private fun extensionForMime(mime: String?): String? {
    if (mime == null) return null
    val m = mime.lowercase(Locale.US)
    RAW_MIME_EXTENSIONS[m]?.let { return it }
    return MimeTypeMap.getSingleton().getExtensionFromMimeType(m)
  }

  private fun safeFileName(raw: String?, mime: String?): String {
    var name = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
      .replace(Regex("[\\u0000-\\u001f:*?\"<>|]"), "_").trim().trimStart('.')
    if (name.isEmpty()) name = "shared-" + System.currentTimeMillis()
    if (!name.contains('.')) {
      extensionForMime(mime)?.let { name = name + "." + it }
    }
    return name
  }

  private fun sameContent(context: Context, uri: Uri, file: File, sharedSize: Long): Boolean {
    if (!file.isFile) return false
    if (sharedSize >= 0 && sharedSize != file.length()) return false
    return try {
      BufferedInputStream(openShared(context, uri)).use { a ->
        BufferedInputStream(FileInputStream(file)).use { b -> streamsEqual(a, b) }
      }
    } catch (e: Exception) {
      false
    }
  }

  private fun streamsEqual(a: InputStream, b: InputStream): Boolean {
    val bufA = ByteArray(64 * 1024)
    val bufB = ByteArray(64 * 1024)
    var equal = true
    var done = false
    while (equal && !done) {
      val n = readFully(a, bufA)
      val m = readFully(b, bufB)
      if (n != m) {
        equal = false
      } else if (n == 0) {
        done = true
      } else {
        for (i in 0 until n) {
          if (bufA[i] != bufB[i]) {
            equal = false
            break
          }
        }
      }
    }
    return equal
  }

  private fun readFully(input: InputStream, buf: ByteArray): Int {
    var total = 0
    while (total < buf.size) {
      val n = input.read(buf, total, buf.size - total)
      if (n < 0) break
      total += n
    }
    return total
  }

  /** Copies one shared file into dir; returns the copy (or the identical file already there). */
  private fun copyShared(context: Context, uri: Uri, dir: File): File {
    val (sharedName, sharedSize) = describeShared(context, uri)
    val mime = if (uri.scheme == "content") context.contentResolver.getType(uri) else null
    val name = safeFileName(sharedName, mime)
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create " + dir)

    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var n = 0
    while (n < 1000) {
      val candidate = File(dir, if (n == 0) name else base + " (" + n + ")" + ext)
      if (!candidate.exists()) {
        val part = File(dir, "." + candidate.name + ".part")
        try {
          openShared(context, uri).use { input ->
            part.outputStream().use { output -> input.copyTo(output, 256 * 1024) }
          }
          if (!part.renameTo(candidate)) throw IOException("Cannot rename " + part)
        } finally {
          if (part.exists()) part.delete()
        }
        return candidate
      }
      if (sameContent(context, uri, candidate, sharedSize)) return candidate
      n++
    }
    throw IOException("Too many files named " + name)
  }

  private fun writeInboxNote(inbox: File, paths: JSONArray, failed: Int) {
    if (paths.length() == 0 && failed == 0) return
    if (!inbox.isDirectory && !inbox.mkdirs()) throw IOException("Cannot create " + inbox)
    val note = JSONObject().put("paths", paths).put("failed", failed)
    val stem = System.currentTimeMillis().toString() + "-" + (inboxNoteSeq++)
    val tmp = File(inbox, stem + ".json.tmp")
    tmp.writeText(note.toString())
    if (!tmp.renameTo(File(inbox, stem + ".json"))) {
      tmp.delete()
      throw IOException("Cannot rename " + tmp)
    }
  }

  companion object {
    private const val TAG = "RapidRAWShare"
    private const val INBOX_DIR = "shared-inbox"

    // RAW types Android's MimeTypeMap doesn't know (used when the sender gives no file extension)
    private val RAW_MIME_EXTENSIONS = mapOf(
      "image/x-fuji-raf" to "raf",
      "image/x-adobe-dng" to "dng",
      "image/dng" to "dng",
      "application/x-adobe-dng" to "dng",
      "application/dng" to "dng",
      "image/x-canon-cr2" to "cr2",
      "image/x-canon-cr3" to "cr3",
      "image/x-canon-crw" to "crw",
      "image/x-nikon-nef" to "nef",
      "image/x-nikon-nrw" to "nrw",
      "image/x-sony-arw" to "arw",
      "image/x-sony-sr2" to "sr2",
      "image/x-sony-srf" to "srf",
      "image/x-olympus-orf" to "orf",
      "image/x-panasonic-rw2" to "rw2",
      "image/x-panasonic-raw" to "raw",
      "image/x-pentax-pef" to "pef",
      "image/x-samsung-srw" to "srw",
      "image/x-sigma-x3f" to "x3f",
      "image/x-hasselblad-3fr" to "3fr",
      "image/x-leica-rwl" to "rwl",
      "image/x-minolta-mrw" to "mrw",
      "image/x-kodak-dcr" to "dcr",
      "image/x-epson-erf" to "erf",
      "image/heic" to "heic",
      "image/heif" to "heif"
    )
  }
}
