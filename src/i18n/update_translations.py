import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Motor Apple RAW 9",
                    "appleRaw9Desc": "Revela els fitxers RAW amb el descodificador RAW 9 de Core Image d'Apple, que realitza el procés de demosaic i reducció de soroll en un sol pas al Neural Engine. Requereix macOS 27 o posterior i una càmera compatible; els fitxers no compatibles utilitzen automàticament el descodificador integrat. Més lent que el descodificador per defecte. Les miniatures no es veuen afectades.",
                    "enableAppleRaw9": "Utilitza Apple RAW 9 per als fitxers RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "de": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 Engine",
                    "appleRaw9Desc": "Entwickelt RAW-Dateien mit Apples Core-Image-Decoder RAW 9, der Demosaicing und Entrauschen in einem Schritt auf der Neural Engine ausführt. Erfordert macOS 27 oder neuer und eine unterstützte Kamera; nicht unterstützte Dateien verwenden automatisch den integrierten Decoder. Langsamer als der Standard-Decoder. Vorschaubilder sind nicht betroffen.",
                    "enableAppleRaw9": "Apple RAW 9 für RAW-Dateien verwenden"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "en": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 Engine",
                    "appleRaw9Desc": "Develop RAW files with Apple's Core Image RAW 9 decoder, which demosaics and denoises in one step on the Neural Engine. Requires macOS 27 or later and a supported camera; unsupported files automatically use the built-in decoder. Slower than the default decoder. Thumbnails are not affected.",
                    "enableAppleRaw9": "Use Apple RAW 9 for RAW files"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "es": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Motor Apple RAW 9",
                    "appleRaw9Desc": "Revela archivos RAW con el decodificador RAW 9 de Core Image de Apple, que realiza el interpolado cromático y reduce el ruido en un solo paso en el Neural Engine. Requiere macOS 27 o posterior y una cámara compatible; los archivos no compatibles usan automáticamente el decodificador integrado. Más lento que el decodificador predeterminado. Las miniaturas no se ven afectadas.",
                    "enableAppleRaw9": "Usar Apple RAW 9 para archivos RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "fr": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Moteur Apple RAW 9",
                    "appleRaw9Desc": "Développe les fichiers RAW avec le décodeur RAW 9 de Core Image d'Apple, qui effectue le dématriçage et la réduction de bruit en une seule étape sur le Neural Engine. Nécessite macOS 27 ou ultérieur et un appareil photo pris en charge ; les fichiers non pris en charge utilisent automatiquement le décodeur intégré. Plus lent que le décodeur par défaut. Les miniatures ne sont pas affectées.",
                    "enableAppleRaw9": "Utiliser Apple RAW 9 pour les fichiers RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "it": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Motore Apple RAW 9",
                    "appleRaw9Desc": "Sviluppa i file RAW con il decodificatore RAW 9 di Core Image di Apple, che esegue la demosaicizzazione e la riduzione del rumore in un solo passaggio sul Neural Engine. Richiede macOS 27 o successivo e una fotocamera supportata; i file non supportati utilizzano automaticamente il decodificatore integrato. Più lento del decodificatore predefinito. Le miniature non ne sono influenzate.",
                    "enableAppleRaw9": "Usa Apple RAW 9 per i file RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "ja": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 エンジン",
                    "appleRaw9Desc": "AppleのCore Image RAW 9デコーダを使用してRAWファイルを現像します。これはNeural Engine上でデモザイク処理とノイズ低減を1ステップで行います。macOS 27以降および対応カメラが必要です。未対応のファイルは自動的に内蔵デコーダを使用します。デフォルトのデコーダより低速です。サムネイルには影響しません。",
                    "enableAppleRaw9": "RAWファイルにApple RAW 9を使用する"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "ko": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 엔진",
                    "appleRaw9Desc": "Apple의 Core Image RAW 9 디코더로 RAW 파일을 현상합니다. Neural Engine에서 디모자이크와 노이즈 제거를 한 번에 처리합니다. macOS 27 이상 및 지원되는 카메라가 필요하며, 지원되지 않는 파일은 내장 디코더를 자동으로 사용합니다. 기본 디코더보다 느립니다. 썸네일에는 영향을 주지 않습니다.",
                    "enableAppleRaw9": "RAW 파일에 Apple RAW 9 사용"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "pl": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Silnik Apple RAW 9",
                    "appleRaw9Desc": "Wywołuj pliki RAW za pomocą dekodera RAW 9 w Core Image od Apple, który przeprowadza demozaikowanie i odszumianie w jednym kroku w silniku Neural Engine. Wymaga systemu macOS 27 lub nowszego oraz obsługiwanego aparatu; nieobsługiwane pliki automatycznie korzystają z wbudowanego dekodera. Wolniejszy niż domyślny dekoder. Nie wpływa na miniatury.",
                    "enableAppleRaw9": "Używaj Apple RAW 9 dla plików RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "pt": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Motor Apple RAW 9",
                    "appleRaw9Desc": "Revela ficheiros RAW com o descodificador RAW 9 do Core Image da Apple, que faz o demosaicing e reduz o ruído num só passo no Neural Engine. Requer o macOS 27 ou posterior e uma câmara suportada; ficheiros não suportados usam automaticamente o descodificador integrado. Mais lento que o descodificador padrão. As miniaturas não são afetadas.",
                    "enableAppleRaw9": "Usar Apple RAW 9 para ficheiros RAW"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "ru": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Движок Apple RAW 9",
                    "appleRaw9Desc": "Проявка RAW-файлов с помощью декодера Apple Core Image RAW 9, который выполняет демозаику и шумоподавление за один шаг с использованием Neural Engine. Требуется macOS 27 или новее и поддерживаемая камера; неподдерживаемые файлы автоматически используют встроенный декодер. Работает медленнее, чем декодер по умолчанию. На миниатюры не влияет.",
                    "enableAppleRaw9": "Использовать Apple RAW 9 для RAW-файлов"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "zh-CN": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 引擎",
                    "appleRaw9Desc": "使用 Apple 的 Core Image RAW 9 解码器冲洗 RAW 文件。它在神经网络引擎 (Neural Engine) 上一步完成去马赛克和降噪。需要 macOS 27 或更高版本以及支持的相机；不支持的文件将自动使用内置解码器。比默认解码器慢。缩略图不受影响。",
                    "enableAppleRaw9": "对 RAW 文件使用 Apple RAW 9"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    },
    "zh-TW": {
        "settings": {
            "processing": {
                "preprocessing": {
                    "appleRaw9": "Apple RAW 9 引擎",
                    "appleRaw9Desc": "使用 Apple 的 Core Image RAW 9 解碼器沖洗 RAW 檔案。它在神經網路引擎 (Neural Engine) 上一步完成去馬賽克與降噪。需要 macOS 27 或更高版本以及支援的相機；不支援的檔案將自動使用內建解碼器。比預設解碼器慢。縮圖不受影響。",
                    "enableAppleRaw9": "對 RAW 檔案使用 Apple RAW 9"
                }
            }
        },
        "modals": {
            "denoise": {
                "methodRaw9": "Apple RAW 9 (Neural Engine)"
            }
        }
    }
}

def deep_merge(target: dict, source: dict):
    """Recursively merges source dict into target dict."""
    for key, value in source.items():
        if isinstance(value, dict):
            node = target.setdefault(key, {})
            if isinstance(node, dict):
                deep_merge(node, value)
        else:
            target[key] = value

def sort_dict_recursively(item):
    if isinstance(item, dict):
        return {k: sort_dict_recursively(v) for k, v in sorted(item.items())}
    elif isinstance(item, list):
        return [sort_dict_recursively(x) for x in item]
    return item

def update_json_file(file_path: Path, trans: dict):
    if not file_path.exists():
        print(f"Skipping: {file_path.name} (File not found)")
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print(f"Error parsing JSON in {file_path.name}. Skipping.")
        return

    deep_merge(data, trans)

    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting translation updates for Apple RAW 9 keys...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
