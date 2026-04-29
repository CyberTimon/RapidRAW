package io.github.CyberTimon.RapidRAW

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val safeMarginBackgroundColor = Color.rgb(24, 24, 24)
  private var webView: WebView? = null
  private var backCallback: OnBackPressedCallback? = null

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
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    this.webView = webView
    webView.setBackgroundColor(safeMarginBackgroundColor)
    webView.fitsSystemWindows = true

    if (backCallback == null) {
      val callback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          dispatchBackToWebView(this)
        }
      }

      backCallback = callback
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  private fun dispatchBackToWebView(callback: OnBackPressedCallback) {
    val currentWebView = webView
    if (currentWebView == null) {
      continueDefaultBack(callback)
      return
    }

    currentWebView.evaluateJavascript(ANDROID_BACK_EVENT_SCRIPT) { result ->
      if (result != "true") {
        if (currentWebView.canGoBack()) {
          currentWebView.goBack()
        } else {
          continueDefaultBack(callback)
        }
      }
    }
  }

  private fun continueDefaultBack(callback: OnBackPressedCallback) {
    callback.isEnabled = false
    try {
      onBackPressedDispatcher.onBackPressed()
    } finally {
      callback.isEnabled = true
    }
  }

  companion object {
    private const val ANDROID_BACK_EVENT_SCRIPT = """
      (function () {
        try {
          var event = new CustomEvent('rapidraw:android-back', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented === true;
        } catch (error) {
          return false;
        }
      })();
    """
  }
}
