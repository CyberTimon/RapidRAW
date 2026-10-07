import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Connectant…",
                            "retry": "Tornar a intentar la connexió",
                            "unsupported": "L'inici de sessió al núvol actualment només està disponible a l'escriptori."
                        }
                    }
                }
            }
        }
    },
    "cs": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Připojování…",
                            "retry": "Opakovat připojení",
                            "unsupported": "Přihlášení do cloudu je momentálně k dispozici pouze na počítači."
                        }
                    }
                }
            }
        }
    },
    "de": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Verbinden…",
                            "retry": "Verbindung erneut versuchen",
                            "unsupported": "Die Cloud-Anmeldung ist derzeit nur auf dem Desktop verfügbar."
                        }
                    }
                }
            }
        }
    },
    "en": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Connecting…",
                            "retry": "Retry connection",
                            "unsupported": "Cloud sign-in is currently only available on desktop."
                        }
                    }
                }
            }
        }
    },
    "es": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Conectando…",
                            "retry": "Reintentar conexión",
                            "unsupported": "El inicio de sesión en la nube actualmente solo está disponible en escritorio."
                        }
                    }
                }
            }
        }
    },
    "fr": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Connexion…",
                            "retry": "Réessayer la connexion",
                            "unsupported": "La connexion au cloud n'est actuellement disponible que sur ordinateur."
                        }
                    }
                }
            }
        }
    },
    "it": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Connessione in corso…",
                            "retry": "Riprova connessione",
                            "unsupported": "L'accesso al cloud è attualmente disponibile solo su desktop."
                        }
                    }
                }
            }
        }
    },
    "ja": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "接続中…",
                            "retry": "接続を再試行",
                            "unsupported": "クラウドへのサインインは現在、デスクトップでのみ利用可能です。"
                        }
                    }
                }
            }
        }
    },
    "ko": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "연결 중…",
                            "retry": "연결 재시도",
                            "unsupported": "클라우드 로그인은 현재 데스크톱에서만 사용할 수 있습니다."
                        }
                    }
                }
            }
        }
    },
    "nl": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Verbinden…",
                            "retry": "Verbinding opnieuw proberen",
                            "unsupported": "Aanmelden bij de cloud is momenteel alleen beschikbaar op desktop."
                        }
                    }
                }
            }
        }
    },
    "pl": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Łączenie…",
                            "retry": "Ponów próbę połączenia",
                            "unsupported": "Logowanie w chmurze jest obecnie dostępne tylko na komputerach."
                        }
                    }
                }
            }
        }
    },
    "pt": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Conectando…",
                            "retry": "Tentar conexão novamente",
                            "unsupported": "O login na nuvem está atualmente disponível apenas no desktop."
                        }
                    }
                }
            }
        }
    },
    "ru": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "Подключение…",
                            "retry": "Повторить попытку подключения",
                            "unsupported": "Вход в облако в настоящее время доступен только на ПК."
                        }
                    }
                }
            }
        }
    },
    "zh-CN": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "正在连接…",
                            "retry": "重试连接",
                            "unsupported": "云端登录目前仅在桌面设备上可用。"
                        }
                    }
                }
            }
        }
    },
    "zh-TW": {
        "settings": {
            "processing": {
                "ai": {
                    "cloud": {
                        "statuses": {
                            "connecting": "連線中…",
                            "retry": "重試連線",
                            "unsupported": "雲端登入目前僅在桌面裝置上可用。"
                        }
                    }
                }
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

    print("Starting translation updates for Cloud Statuses...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
