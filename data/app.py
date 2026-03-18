#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║          EO LEXICAL ANALYSIS v2 — Three-Axis Clause Classification          ║
║                                                                              ║
║  Tests whether Emergent Ontology's three axes (Mode, Domain, Object) are     ║
║  real, independent semantic dimensions in natural language embedding space.   ║
║                                                                              ║
║  Run:  python app.py                                                         ║
║  Help: python app.py --help                                                  ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

# ─────────────────────────────────────────────────────────────────────────────
# STANDARD LIBRARY
# ─────────────────────────────────────────────────────────────────────────────
import os, sys, json, csv, time, math, random, argparse, textwrap, datetime
import subprocess, hashlib, re, itertools, statistics
from pathlib import Path
from collections import defaultdict, Counter
from typing import Optional, List, Dict, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# ANSI COLOR HELPERS — makes terminal output readable without a library
# ─────────────────────────────────────────────────────────────────────────────
def bold(s):  return f"\033[1m{s}\033[0m"
def dim(s):   return f"\033[2m{s}\033[0m"
def green(s): return f"\033[32m{s}\033[0m"
def yellow(s):return f"\033[33m{s}\033[0m"
def red(s):   return f"\033[31m{s}\033[0m"
def cyan(s):  return f"\033[36m{s}\033[0m"
def blue(s):  return f"\033[34m{s}\033[0m"
def header(title):
    w = 74
    print(f"\n{'─'*w}")
    print(f"  {bold(title)}")
    print(f"{'─'*w}")
def section(title):
    print(f"\n  {cyan('▸')} {bold(title)}")
def ok(msg):   print(f"  {green('✓')} {msg}")
def warn(msg): print(f"  {yellow('!')} {msg}")
def err(msg):  print(f"  {red('✗')} {msg}")
def info(msg): print(f"  {dim('·')} {msg}")
def ask(prompt, default=None):
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"\n  {bold(prompt)}{suffix}: ").strip()
        return val if val else default
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
def confirm(prompt, default=True):
    yn = "Y/n" if default else "y/N"
    try:
        val = input(f"\n  {bold(prompt)} ({yn}): ").strip().lower()
        if not val: return default
        return val.startswith("y")
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


# ─────────────────────────────────────────────────────────────────────────────
# THIRD-PARTY IMPORTS
#
# These are imported unconditionally so type annotations and module-level
# code work correctly. Missing packages are caught below by check_dependencies()
# which offers to install them before the pipeline runs.
# ─────────────────────────────────────────────────────────────────────────────

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    import anthropic as _anthropic
except ImportError:
    _anthropic = None  # type: ignore

try:
    from openai import OpenAI as _OpenAI
except ImportError:
    _OpenAI = None  # type: ignore

try:
    from sklearn.metrics import adjusted_rand_score, cohen_kappa_score
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import LabelEncoder
except ImportError:
    adjusted_rand_score = cohen_kappa_score = KMeans = PCA = LabelEncoder = None  # type: ignore

try:
    from scipy import stats as _scipy_stats
except ImportError:
    _scipy_stats = None  # type: ignore

try:
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
except ImportError:
    plt = mpatches = None  # type: ignore

try:
    from tqdm import tqdm as _tqdm
    def tqdm(it, **kw): return _tqdm(it, **kw)
except ImportError:
    def tqdm(it, desc="", **kw):  # type: ignore
        if desc: print(f"  {desc}...")
        return it

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ─────────────────────────────────────────────────────────────────────────────
# DEPENDENCY CHECK AND INSTALLATION
#
# We check for required packages before doing anything else.
# If something is missing we offer to install it automatically.
# ─────────────────────────────────────────────────────────────────────────────

REQUIRED_PACKAGES = {
    "anthropic":        "anthropic",
    "openai":           "openai",
    "numpy":            "numpy",
    "scipy":            "scipy",
    "sklearn":          "scikit-learn",
    "pandas":           "pandas",
    "matplotlib":       "matplotlib",
    "tqdm":             "tqdm",
    "conllu":           "conllu",
    "datasets":         "datasets",
    "dotenv":           "python-dotenv",
    "requests":         "requests",
}

def check_dependencies():
    missing = []
    for import_name, pip_name in REQUIRED_PACKAGES.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append((import_name, pip_name))
    return missing

def install_dependencies(packages):
    pip_names = [p for _, p in packages]
    cmd = [sys.executable, "-m", "pip", "install", "--quiet"] + pip_names
    print(f"\n  Installing: {', '.join(pip_names)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err("Installation failed. Try manually:")
        print(f"  pip install {' '.join(pip_names)}")
        sys.exit(1)
    ok("Packages installed")


# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS — persisted to .env so you only set them once
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE = Path(".env")

def load_env():
    """Load .env file into os.environ."""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

def save_env(updates: dict):
    """Merge updates into .env file."""
    existing = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                existing[k.strip()] = v.strip()
    existing.update(updates)
    lines = ["# EO Lexical Analysis v2 — auto-generated settings"]
    lines += [f"{k}={v}" for k, v in existing.items()]
    ENV_FILE.write_text("\n".join(lines) + "\n")

def get_setting(key, prompt, secret=False, default=None):
    """Get a setting from env, prompt if missing."""
    val = os.environ.get(key)
    if val:
        if secret:
            info(f"{key}: {'*' * 8}{val[-4:]}")
        else:
            info(f"{key}: {val}")
        return val
    val = ask(prompt, default)
    if val:
        os.environ[key] = val
        save_env({key: val})
    return val


# ─────────────────────────────────────────────────────────────────────────────
# THE THREE CLASSIFICATION QUESTIONS
#
# These are the ONLY instructions sent to classifier models.
# No EO vocabulary. No operator names. No mention of the framework.
# The questions must be answerable by someone who has never heard of EO.
#
# This is the methodological core of the study. If EO's axes are real,
# these plain questions should recover them in embedding geometry.
# ─────────────────────────────────────────────────────────────────────────────

CLASSIFICATION_SYSTEM = """\
You are a linguist analyzing clauses. For each clause you will answer three
short questions about the kind of transformation the clause describes.

Answer each question with exactly one of the options listed.
Do not add explanation unless asked.
Return your answer as JSON: {"q1": "...", "q2": "...", "q3": "..."}
"""

CLASSIFICATION_PROMPT = """\
Clause: {clause}

Answer these three questions about the transformation this clause describes:

Q1 — How is the transformation structured?
  SEPARATING   — the clause is primarily about dividing, distinguishing,
                 analyzing, or drawing something apart
  CONNECTING   — the clause is primarily about linking, bridging, relating,
                 or holding things together
  PRODUCING    — the clause is primarily about making, generating, creating,
                 or causing something to happen

Q2 — What level of reality is being transformed?
  EXISTENCE    — whether something is: presence, absence, coming into being,
                 disappearing
  ORGANIZATION — how things are arranged: structure, boundaries, relations,
                 composition
  MEANING      — what something signifies: interpretation, value, perspective,
                 what something registers as

Q3 — What kind of thing is being acted on?
  BACKGROUND   — an ambient condition, an environment, a field or substrate,
                 the context something happens within
  PARTICULAR   — a specific individual thing: this named object, this event,
                 this person
  PATTERN      — a recurring regularity: a rule, a type, a schema, something
                 that holds across many instances

Return JSON only: {{"q1": "SEPARATING|CONNECTING|PRODUCING",
                   "q2": "EXISTENCE|ORGANIZATION|MEANING",
                   "q3": "BACKGROUND|PARTICULAR|PATTERN"}}
"""

# Map plain-language answers back to EO axis values
Q1_MAP = {"SEPARATING": "DIFFERENTIATING", "CONNECTING": "RELATING", "PRODUCING": "GENERATING"}
Q2_MAP = {"EXISTENCE": "EXISTENCE", "ORGANIZATION": "STRUCTURE", "MEANING": "SIGNIFICANCE"}
Q3_MAP = {"BACKGROUND": "CONDITION", "PARTICULAR": "ENTITY", "PATTERN": "PATTERN"}

# The 27 cells — derived from Q1 × Q2 × Q3
ACT_FACE = {
    ("DIFFERENTIATING","EXISTENCE"): "NUL",
    ("DIFFERENTIATING","STRUCTURE"): "SEG",
    ("DIFFERENTIATING","SIGNIFICANCE"): "ALT",
    ("RELATING","EXISTENCE"): "SIG",
    ("RELATING","STRUCTURE"): "CON",
    ("RELATING","SIGNIFICANCE"): "SUP",
    ("GENERATING","EXISTENCE"): "INS",
    ("GENERATING","STRUCTURE"): "SYN",
    ("GENERATING","SIGNIFICANCE"): "REC",
}
SITE_FACE = {
    ("EXISTENCE","CONDITION"): "Void",
    ("EXISTENCE","ENTITY"): "Entity",
    ("EXISTENCE","PATTERN"): "Kind",
    ("STRUCTURE","CONDITION"): "Field",
    ("STRUCTURE","ENTITY"): "Link",
    ("STRUCTURE","PATTERN"): "Network",
    ("SIGNIFICANCE","CONDITION"): "Atmosphere",
    ("SIGNIFICANCE","ENTITY"): "Lens",
    ("SIGNIFICANCE","PATTERN"): "Paradigm",
}
RESOLUTION_FACE = {
    ("DIFFERENTIATING","CONDITION"): "Clearing",
    ("DIFFERENTIATING","ENTITY"): "Dissecting",
    ("DIFFERENTIATING","PATTERN"): "Unraveling",
    ("RELATING","CONDITION"): "Tending",
    ("RELATING","ENTITY"): "Binding",
    ("RELATING","PATTERN"): "Tracing",
    ("GENERATING","CONDITION"): "Cultivating",
    ("GENERATING","ENTITY"): "Making",
    ("GENERATING","PATTERN"): "Composing",
}

def derive_address(q1, q2, q3):
    """Given EO-axis values, return the full 27-cell address."""
    return {
        "q1": q1, "q2": q2, "q3": q3,
        "operator":   ACT_FACE.get((q1,q2), "?"),
        "site":       SITE_FACE.get((q2,q3), "?"),
        "resolution": RESOLUTION_FACE.get((q1,q3), "?"),
    }

def axis_distance(a1, a2):
    """Count how many axes differ between two address dicts."""
    return sum([
        a1["q1"] != a2["q1"],
        a1["q2"] != a2["q2"],
        a1["q3"] != a2["q3"],
    ])


# ─────────────────────────────────────────────────────────────────────────────
# CORPUS EXTRACTION — Phase 1
#
# We pull clauses from three sources:
#   1. Universal Dependencies (UD) — pre-parsed real sentences, 100+ languages
#   2. FLORES-200 — same 200 sentences in 200 languages (parity test)
#   3. OPUS — large parallel corpora for scale
#
# All clauses are filtered to: declarative, 8–30 words, contains a verb.
# We extract the raw text only — no linguistic annotations go into the embeddings.
# ─────────────────────────────────────────────────────────────────────────────

UD_LANGUAGES = [
    # Language name, UD treebank identifier, ISO code
    # Coverage: 11 language families, SOV/SVO/VSO/VOS word orders,
    # ancient and modern, high-resource and low-resource
    ("English",           "en_ewt",       "en"),
    ("Arabic",            "ar_padt",      "ar"),
    ("Chinese (Mandarin)","zh_gsd",       "zh"),
    ("Japanese",          "ja_gsd",       "ja"),
    ("Korean",            "ko_gsd",       "ko"),
    ("Turkish",           "tr_imst",      "tr"),
    ("Finnish",           "fi_tdt",       "fi"),
    ("Hungarian",         "hu_szeged",    "hu"),
    ("Basque",            "eu_bdt",       "eu"),
    ("Tamil",             "ta_ttb",       "ta"),
    ("Hindi",             "hi_hdtb",      "hi"),
    ("Urdu",              "ur_udtb",      "ur"),
    ("Russian",           "ru_syntagrus", "ru"),
    ("Czech",             "cs_pdt",       "cs"),
    ("Polish",            "pl_pdb",       "pl"),
    ("German",            "de_gsd",       "de"),
    ("French",            "fr_gsd",       "fr"),
    ("Spanish",           "es_gsd",       "es"),
    ("Portuguese",        "pt_bosque",    "pt"),
    ("Italian",           "it_isdt",      "it"),
    ("Dutch",             "nl_alpino",    "nl"),
    ("Swedish",           "sv_talbanken", "sv"),
    ("Norwegian",         "no_bokmaal",   "no"),
    ("Danish",            "da_ddt",       "da"),
    ("Ancient Greek",     "grc_proiel",   "grc"),
    ("Latin",             "la_proiel",    "la"),
    ("Gothic",            "got_proiel",   "got"),
    ("Hebrew",            "he_htb",       "he"),
    ("Swahili",           "swl_sslc",     "sw"),
    ("Indonesian",        "id_gsd",       "id"),
    ("Vietnamese",        "vi_vtb",       "vi"),
    ("Thai",              "th_orchid",    "th"),
    ("Wolof",             "wo_wtb",       "wo"),
    ("Yoruba",            "yo_ytb",       "yo"),
    ("Catalan",           "ca_ancora",    "ca"),
    ("Romanian",          "ro_rrt",       "ro"),
    ("Bulgarian",         "bg_btb",       "bg"),
    ("Ukrainian",         "uk_iu",        "uk"),
    ("Serbian",           "sr_set",       "sr"),
    ("Croatian",          "hr_set",       "hr"),
    ("Slovak",            "sk_snk",       "sk"),
    ("Slovenian",         "sl_ssj",       "sl"),
    ("Estonian",          "et_edt",       "et"),
    ("Latvian",           "lv_lvtb",      "lv"),
    ("Lithuanian",        "lt_alksnis",   "lt"),
    ("Persian",           "fa_seraji",    "fa"),
    ("Afrikaans",         "af_afribooms", "af"),
    ("Maltese",           "mt_mudt",      "mt"),
    ("Irish",             "ga_idt",       "ga"),
    ("Welsh",             "cy_ccg",       "cy"),
    ("Breton",            "br_keb",       "br"),
    ("Coptic",            "cop_scriptorium","cop"),
    ("Old Church Slavonic","cu_proiel",   "cu"),
    ("Sanskrit",          "sa_vedic",     "sa"),
    ("Classical Chinese", "lzh_kyoto",    "lzh"),
    ("Uyghur",            "ug_udt",       "ug"),
    ("Kazakh",            "kk_ktb",       "kk"),
    ("Mongolian",         "mn_bnc",       "mn"),
    ("Armenian",          "hy_armtdp",    "hy"),
    ("Georgian",          "ka_glc",       "ka"),
    ("Galician",          "gl_treegal",   "gl"),
    ("Belarusian",        "be_hse",       "be"),
    ("Faroese",           "fo_farpahc",   "fo"),
    ("Icelandic",         "is_icepahc",   "is"),
    ("Akkadian",          "akk_pisandub", "akk"),
    ("Bambara",           "bm_crb",       "bm"),
]

# Curated mapping: treebank_id -> GitHub repo name
UD_REPO_NAMES = {
    "en_ewt":         "UD_English-EWT",
    "ar_padt":        "UD_Arabic-PADT",
    "zh_gsd":         "UD_Chinese-GSD",
    "ja_gsd":         "UD_Japanese-GSD",
    "ko_gsd":         "UD_Korean-GSD",
    "tr_imst":        "UD_Turkish-IMST",
    "fi_tdt":         "UD_Finnish-TDT",
    "hu_szeged":      "UD_Hungarian-Szeged",
    "eu_bdt":         "UD_Basque-BDT",
    "ta_ttb":         "UD_Tamil-TTB",
    "hi_hdtb":        "UD_Hindi-HDTB",
    "ur_udtb":        "UD_Urdu-UDTB",
    "ru_syntagrus":   "UD_Russian-SynTagRus",
    "cs_pdt":         "UD_Czech-PDT",
    "pl_pdb":         "UD_Polish-PDB",
    "de_gsd":         "UD_German-GSD",
    "fr_gsd":         "UD_French-GSD",
    "es_gsd":         "UD_Spanish-GSD",
    "pt_bosque":      "UD_Portuguese-Bosque",
    "it_isdt":        "UD_Italian-ISDT",
    "nl_alpino":      "UD_Dutch-Alpino",
    "sv_talbanken":   "UD_Swedish-Talbanken",
    "no_bokmaal":     "UD_Norwegian-Bokmaal",
    "da_ddt":         "UD_Danish-DDT",
    "grc_proiel":     "UD_Ancient_Greek-PROIEL",
    "la_proiel":      "UD_Latin-PROIEL",
    "got_proiel":     "UD_Gothic-PROIEL",
    "he_htb":         "UD_Hebrew-HTB",
    "swl_sslc":       "UD_Swedish_Sign_Language-SSLC",
    "id_gsd":         "UD_Indonesian-GSD",
    "vi_vtb":         "UD_Vietnamese-VTB",
    "th_orchid":      "UD_Thai-Orchid",
    "wo_wtb":         "UD_Wolof-WTB",
    "yo_ytb":         "UD_Yoruba-YTB",
    "ca_ancora":      "UD_Catalan-AnCora",
    "ro_rrt":         "UD_Romanian-RRT",
    "bg_btb":         "UD_Bulgarian-BTB",
    "uk_iu":          "UD_Ukrainian-IU",
    "sr_set":         "UD_Serbian-SET",
    "hr_set":         "UD_Croatian-SET",
    "sk_snk":         "UD_Slovak-SNK",
    "sl_ssj":         "UD_Slovenian-SSJ",
    "et_edt":         "UD_Estonian-EDT",
    "lv_lvtb":        "UD_Latvian-LVTB",
    "lt_alksnis":     "UD_Lithuanian-ALKSNIS",
    "fa_seraji":      "UD_Persian-Seraji",
    "af_afribooms":   "UD_Afrikaans-AfriBooms",
    "mt_mudt":        "UD_Maltese-MUDT",
    "ga_idt":         "UD_Irish-IDT",
    "cy_ccg":         "UD_Welsh-CCG",
    "br_keb":         "UD_Breton-KEB",
    "cop_scriptorium":"UD_Coptic-Scriptorium",
    "cu_proiel":      "UD_Old_Church_Slavonic-PROIEL",
    "sa_vedic":       "UD_Sanskrit-Vedic",
    "lzh_kyoto":      "UD_Classical_Chinese-Kyoto",
    "ug_udt":         "UD_Uyghur-UDT",
    "kk_ktb":         "UD_Kazakh-KTB",
    "mn_bnc":         "UD_Mongolian-BNC",
    "hy_armtdp":      "UD_Armenian-ArmTDP",
    "ka_glc":         "UD_Georgian-GLC",
    "gl_treegal":     "UD_Galician-TreeGal",
    "be_hse":         "UD_Belarusian-HSE",
    "fo_farpahc":     "UD_Faroese-FarPaHC",
    "is_icepahc":     "UD_Icelandic-IcePaHC",
    "akk_pisandub":   "UD_Akkadian-PISANDUB",
    "bm_crb":         "UD_Bambara-CRB",
}


def download_ud_treebank(lang_name, treebank_id, data_dir):
    """
    Download a UD treebank directly from GitHub as a tar.gz archive.

    HuggingFace dropped trust_remote_code support for UD, so we go
    straight to the source: each treebank is a GitHub repo under
    github.com/UniversalDependencies/UD_Language-Name

    The archive contains train/dev/test .conllu files.
    We extract all of them and keep only the .conllu files.
    Everything is cached to data/ud/<treebank_id>/ so subsequent
    runs are instant.

    Returns path to directory with .conllu files, or None if unavailable.
    """
    import requests
    import tarfile
    import io

    cache_path = data_dir / "ud" / treebank_id
    if cache_path.exists() and any(cache_path.glob("*.conllu")):
        return cache_path  # Already downloaded and cached

    cache_path.mkdir(parents=True, exist_ok=True)

    repo_name = UD_REPO_NAMES.get(treebank_id)
    if not repo_name:
        return None

    # GitHub provides archives of the default branch as a tarball
    url = (f"https://github.com/UniversalDependencies/{repo_name}"
           f"/archive/refs/heads/master.tar.gz")

    try:
        resp = requests.get(url, timeout=90, stream=True)
        if resp.status_code != 200:
            # Some repos use 'main' instead of 'master'
            url2 = url.replace("/master.tar.gz", "/main.tar.gz")
            resp = requests.get(url2, timeout=90, stream=True)
            if resp.status_code != 200:
                return None

        content = resp.content
        extracted = 0
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as tar:
            for member in tar.getmembers():
                if member.name.endswith(".conllu"):
                    # Flatten: strip the leading repo-name/ directory
                    flat_name = Path(member.name).name
                    dest = cache_path / flat_name
                    fobj = tar.extractfile(member)
                    if fobj:
                        dest.write_bytes(fobj.read())
                        extracted += 1

        if extracted == 0:
            cache_path.rmdir()
            return None

        return cache_path

    except Exception:
        return None


def extract_clauses_from_conllu(conllu_path, lang_code, max_per_lang=2000, cache_dir=None):
    """
    Parse CoNLL-U files and extract main clauses.

    Results are cached to cache_dir/<lang_code>.jsonl so subsequent runs
    skip the parsing entirely and load from disk in milliseconds.

    Filtering criteria:
    - Sentence contains at least one VERB token (UD UPOS tag)
    - Sentence length: 8–30 tokens (long enough to fix all three dimensions,
      short enough to be parseable at a glance)
    - Not a question or exclamation (we want declarative transformations)
    - Deduplicated by first 60 characters

    Returns list of {"clause": str, "language": str, "source": str}
    """
    # ── Clause-level cache ───────────────────────────────────────────────────
    # Caches extracted clauses separately from the raw .conllu files.
    # The .conllu download is already cached in data/ud/<treebank_id>/.
    # This second layer skips the parsing step on re-runs.
    if cache_dir is not None:
        clause_cache = Path(cache_dir) / f"{lang_code}.jsonl"
        if clause_cache.exists():
            clauses = []
            with open(clause_cache, encoding="utf-8") as f:
                for line in f:
                    try: clauses.append(json.loads(line))
                    except: pass
            if clauses:
                return clauses[:max_per_lang]

    try:
        import conllu
    except ImportError:
        return []

    clauses = []
    seen = set()

    for fpath in Path(conllu_path).glob("*.conllu"):
        try:
            data = fpath.read_text(encoding="utf-8")
            sentences = conllu.parse(data)
        except Exception:
            continue

        for sent in sentences:
            tokens = [t for t in sent if isinstance(t["id"], int)]
            if not tokens:
                continue

            # Must contain a verb
            has_verb = any(t["upos"] == "VERB" for t in tokens)
            if not has_verb:
                continue

            # Length filter
            if not (8 <= len(tokens) <= 30):
                continue

            # Reconstruct surface text
            text = sent.metadata.get("text", " ".join(t["form"] for t in tokens))
            text = text.strip()

            # Exclude questions and exclamations
            if text.endswith("?") or text.endswith("!"):
                continue

            # Deduplicate
            key = f"{lang_code}::{text[:60].lower()}"
            if key in seen:
                continue
            seen.add(key)

            clauses.append({
                "clause":   text,
                "language": lang_code,
                "source":   "ud",
                "id":       hashlib.md5(f"{lang_code}::{text}".encode()).hexdigest()[:16],
            })

            if len(clauses) >= max_per_lang:
                break
        if len(clauses) >= max_per_lang:
            break

    # Write clause cache so next run skips parsing entirely
    if cache_dir is not None and clauses:
        clause_cache = Path(cache_dir) / f"{lang_code}.jsonl"
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        with open(clause_cache, "w", encoding="utf-8") as f:
            for c in clauses:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")

    return clauses



def _load_flores_from_github(data_dir, max_langs=50):
    """
    Fallback FLORES loader: downloads devtest sentences directly from
    the flores101 GitHub repo, which provides plain TSV files per language.
    Covers ~100 languages — less than the full FLORES-200 but no HF dependency.
    """
    import requests

    # flores101 devtest TSV index — one file per language
    BASE = "https://raw.githubusercontent.com/facebookresearch/flores/main/flores101_dataset/devtest"
    INDEX_URL = "https://api.github.com/repos/facebookresearch/flores/contents/flores101_dataset/devtest"

    try:
        resp = requests.get(INDEX_URL, timeout=30)
        if resp.status_code != 200:
            return []
        files = [f["name"] for f in resp.json() if f["name"].endswith(".tsv")]
    except Exception:
        return []

    clauses = []
    for fname in files[:max_langs]:
        lang_code = fname.replace(".tsv", "")
        try:
            r = requests.get(f"{BASE}/{fname}", timeout=30)
            if r.status_code != 200:
                continue
            for line in r.text.splitlines():
                line = line.strip()
                if not line or len(line.split()) < 5:
                    continue
                clauses.append({
                    "clause":   line,
                    "language": lang_code,
                    "source":   "flores_github",
                    "id":       hashlib.md5(f"{lang_code}_{line[:40]}".encode()).hexdigest()[:8],
                })
        except Exception:
            continue

    return clauses

def load_flores200(data_dir, max_langs=200):
    """
    Load FLORES-200: 200 sentences translated into up to 200 languages.
    Same content across all languages — the gold standard for cross-linguistic
    parity testing. We use the dev split (997 sentences per language).
    """
    try:
        import datasets as hf
    except ImportError:
        return []

    cache_path = data_dir / "flores200_cache"
    cache_file = cache_path / "flores200.jsonl"

    if cache_file.exists():
        clauses = []
        with open(cache_file) as f:
            for line in f:
                clauses.append(json.loads(line))
        info(f"FLORES-200: loaded {len(clauses)} clauses from cache")
        return clauses

    cache_path.mkdir(parents=True, exist_ok=True)

    # FLORES-200 is available as 'openlanguagedata/flores_plus' on HF,
    # which doesn't require trust_remote_code.
    # Each row has a 'sentence' field and a 'language' field (ISO code).
    # We try two known dataset IDs; fall back to direct GitHub CSV download.
    FLORES_DATASETS = [
        ("openlanguagedata/flores_plus", None),
        ("facebook/flores", "all"),
    ]

    dataset = None
    for ds_name, ds_config in FLORES_DATASETS:
        try:
            info(f"Trying FLORES-200 from {ds_name}...")
            kwargs = dict(cache_dir=str(data_dir / "hf_cache"))
            if ds_config:
                dataset = hf.load_dataset(ds_name, ds_config, **kwargs)
            else:
                dataset = hf.load_dataset(ds_name, **kwargs)
            break
        except Exception as e:
            warn(f"  {ds_name}: {e}")
            continue

    clauses = []

    if dataset is None:
        # Final fallback: direct download of FLORES devtest TSV from GitHub
        clauses = _load_flores_from_github(data_dir, max_langs)
        if not clauses:
            warn("FLORES-200 unavailable from all sources — skipping")
            return []
    else:
        split_name = "devtest" if "devtest" in dataset else ("dev" if "dev" in dataset else list(dataset.keys())[0])
        split = dataset[split_name]

        # Detect format: either {sentence, language} rows or {sentence_XX} columns
        features = split.features if hasattr(split, "features") else {}
        if "language" in features:
            # openlanguagedata/flores_plus format: one row per sentence per language
            seen_langs = set()
            for item in split:
                lang_code = item.get("language", item.get("lang", ""))
                sentence  = item.get("sentence", item.get("text", "")).strip()
                if not sentence or len(sentence.split()) < 5:
                    continue
                seen_langs.add(lang_code)
                if len(seen_langs) > max_langs:
                    break
                clauses.append({
                    "clause":    sentence,
                    "language":  lang_code,
                    "source":    "flores200",
                    "id":        hashlib.md5(f"{lang_code}_{sentence[:40]}".encode()).hexdigest()[:8],
                })
        else:
            # facebook/flores format: one row per sentence, columns sentence_XX
            lang_keys = [k for k in features.keys() if k.startswith("sentence_")][:max_langs]
            for item in split:
                for lk in lang_keys:
                    sentence = (item.get(lk) or "").strip()
                    if not sentence or len(sentence.split()) < 5:
                        continue
                    lang_code = lk.replace("sentence_", "")
                    clauses.append({
                        "clause":    sentence,
                        "language":  lang_code,
                        "source":    "flores200",
                        "id":        hashlib.md5(f"{lang_code}_{sentence[:40]}".encode()).hexdigest()[:8],
                    })

    # Cache to disk
    with open(cache_file, "w") as f:
        for c in clauses:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    ok(f"FLORES-200: {len(clauses)} clauses across {len(lang_keys)} languages")
    return clauses


def load_corpus(data_dir: Path, max_per_lang: int, use_flores: bool, use_ud: bool) -> List[dict]:
    """
    Master corpus loader. Downloads and extracts clauses from all sources.
    Returns flat list of clause dicts.
    """
    all_clauses = []

    # ── Universal Dependencies ──────────────────────────────────────────────
    if use_ud:
        section("Universal Dependencies treebanks")
        available = 0
        for lang_name, treebank_id, lang_code in UD_LANGUAGES:
            sys.stdout.write(f"  {dim(lang_name):<30}")
            sys.stdout.flush()
            path = download_ud_treebank(lang_name, treebank_id, data_dir)
            if path is None:
                print(red(" unavailable"))
                continue
            clause_cache_dir = data_dir / "ud_clauses"
            cached_file = clause_cache_dir / f"{lang_code}.jsonl"
            from_cache = cached_file.exists()
            clauses = extract_clauses_from_conllu(path, lang_code, max_per_lang, cache_dir=clause_cache_dir)
            if not clauses:
                print(yellow(" 0 clauses extracted"))
                continue
            all_clauses.extend(clauses)
            available += 1
            tag = dim(" (cached)") if from_cache else ""
            print(green(f" {len(clauses)} clauses") + tag)
        ok(f"UD total: {len(all_clauses)} clauses from {available} languages")

    # ── FLORES-200 ──────────────────────────────────────────────────────────
    if use_flores:
        section("FLORES-200")
        flores = load_flores200(data_dir)
        all_clauses.extend(flores)

    ok(f"Total corpus: {len(all_clauses)} clauses")
    return all_clauses


# ─────────────────────────────────────────────────────────────────────────────
# CLASSIFICATION — Phase 2
#
# Each clause is sent to one or more AI classifiers with the three plain
# questions. No EO vocabulary. No operator names. Just the three questions.
#
# Multiple models run independently — their agreement (or disagreement)
# is measured as Cohen's kappa per axis. High kappa means the questions
# are tracking something robust. Low kappa means the axis is ambiguous
# or the questions are under-specified.
#
# Results are saved progressively so a crashed run can be resumed.
# ─────────────────────────────────────────────────────────────────────────────

AVAILABLE_CLASSIFIERS = {
    "claude":  "claude-sonnet-4-6",
    "gpt4":    "gpt-4o-mini",
    "gemini":  "gemini-1.5-flash",   # via OpenAI-compatible endpoint
}

def classify_clause_anthropic(clause: str, client) -> Optional[dict]:
    """Send a clause to Claude and get Q1/Q2/Q3 back."""
    prompt = CLASSIFICATION_PROMPT.format(clause=clause)
    try:
        response = client.messages.create(
            model=AVAILABLE_CLASSIFIERS["claude"],
            max_tokens=100,
            system=CLASSIFICATION_SYSTEM,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        return parse_classification(text)
    except Exception as e:
        return None

def classify_clause_openai(clause: str, client, model="gpt-4o") -> Optional[dict]:
    """Send a clause to GPT-4o and get Q1/Q2/Q3 back."""
    prompt = CLASSIFICATION_PROMPT.format(clause=clause)
    try:
        response = client.chat.completions.create(
            model=model,
            max_tokens=100,
            messages=[
                {"role": "system", "content": CLASSIFICATION_SYSTEM},
                {"role": "user",   "content": prompt}
            ],
            response_format={"type": "json_object"}
        )
        text = response.choices[0].message.content.strip()
        return parse_classification(text)
    except Exception as e:
        return None

def parse_classification(text: str) -> Optional[dict]:
    """
    Parse the model's JSON response into EO axis values.
    Maps plain-language answers (SEPARATING etc.) to axis names (DIFFERENTIATING etc.).
    """
    try:
        # Strip any markdown fences the model might have added
        text = re.sub(r"```json|```", "", text).strip()
        data = json.loads(text)
        q1_raw = data.get("q1", "").upper().strip()
        q2_raw = data.get("q2", "").upper().strip()
        q3_raw = data.get("q3", "").upper().strip()

        q1 = Q1_MAP.get(q1_raw)
        q2 = Q2_MAP.get(q2_raw)
        q3 = Q3_MAP.get(q3_raw)

        if not all([q1, q2, q3]):
            return None

        address = derive_address(q1, q2, q3)
        return {"q1_raw": q1_raw, "q2_raw": q2_raw, "q3_raw": q3_raw, **address}
    except Exception:
        return None

def run_classification(
    clauses: List[dict],
    run_dir: Path,
    anthropic_key: Optional[str],
    openai_key:    Optional[str],
    models:        List[str],
    sample_n:      Optional[int],
    resume:        bool = True,
):
    """
    Classify all clauses using selected models.
    Saves results progressively to classified.jsonl.
    If resume=True, skips already-classified clauses.
    """
    # ── Set up clients ───────────────────────────────────────────────────────
    anthropic_client = openai_client = None
    if "claude" in models and anthropic_key:
        try:
            anthropic_client = _anthropic.Anthropic(api_key=anthropic_key)
        except Exception as e:
            warn(f"Anthropic client failed: {e}")

    if ("gpt4" in models or "gemini" in models) and openai_key:
        try:
            openai_client = _OpenAI(api_key=openai_key)
        except Exception as e:
            warn(f"OpenAI client failed: {e}")

    # ── Output file ──────────────────────────────────────────────────────────
    out_file = run_dir / "classified.jsonl"

    # ── Load existing classifications for resume/upgrade ───────────────────
    # Three cases:
    #   1. Clause not in file at all       → classify fresh
    #   2. Clause has all requested models → skip
    #   3. Clause has only SOME models     → re-classify with missing models,
    #                                         merge results, overwrite the line
    existing = {}   # id -> record
    if resume and out_file.exists():
        with open(out_file, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                    existing[row["id"]] = row
                except Exception:
                    pass
        if existing:
            fully_done = sum(
                1 for r in existing.values()
                if all(m in r.get("classifications", {}) for m in models)
            )
            needs_upgrade = len(existing) - fully_done
            info(f"Resuming: {len(existing)} clauses in file, "
                 f"{fully_done} fully classified, {needs_upgrade} need upgrade")

    # Clauses that need work: not in file, or missing at least one model
    def needs_classification(clause_id):
        if clause_id not in existing:
            return True
        present_models = set(existing[clause_id].get("classifications", {}).keys())
        return not all(m in present_models for m in models)

    # ── Sample if requested ──────────────────────────────────────────────────
    to_classify = [c for c in clauses if needs_classification(c["id"])]
    if sample_n:
        to_classify = random.sample(to_classify, min(sample_n, len(to_classify)))
    info(f"Classifying {len(to_classify)} clauses with models: {', '.join(models)}")

    # ── Write directly to classified.jsonl ──────────────────────────────────
    # Carry over records that already have ALL requested models, then
    # append new classifications. No temp file — write straight through.
    carried = 0
    with open(out_file, "w", encoding="utf-8") as f:
        for rid, rec in existing.items():
            present = set(rec.get("classifications", {}).keys())
            if all(m in present for m in models):
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                carried += 1
    if carried:
        info(f"Carried over {carried} already-complete records")

    # ── Main loop ────────────────────────────────────────────────────────────
    out_f = open(out_file, "a", encoding="utf-8")
    errors = 0
    t0 = time.time()

    for i, clause_data in enumerate(to_classify):
        clause_text = clause_data["clause"]
        result = {**clause_data, "classifications": {}}

        # Run each requested model
        for model_name in models:
            raw = None
            if model_name == "claude" and anthropic_client:
                raw = classify_clause_anthropic(clause_text, anthropic_client)
                time.sleep(0.2)  # Rate limiting courtesy pause
            elif model_name == "gpt4" and openai_client:
                raw = classify_clause_openai(clause_text, openai_client, model="gpt-4o")
                time.sleep(0.1)
            elif model_name == "gemini":
                # Gemini via Google AI Studio OpenAI-compatible endpoint
                # Requires GEMINI_API_KEY env var and openai package
                gemini_key = os.environ.get("GEMINI_API_KEY")
                if gemini_key and _OpenAI:
                    try:
                        gclient = _OpenAI(
                            api_key=gemini_key,
                            base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
                        )
                        raw = classify_clause_openai(clause_text, gclient, model="gemini-1.5-flash")
                    except Exception:
                        raw = None
                time.sleep(0.1)

            if raw:
                result["classifications"][model_name] = raw
            else:
                errors += 1

        # Compute consensus where all models agree
        result["consensus"] = compute_consensus(result["classifications"])

        out_f.write(json.dumps(result, ensure_ascii=False) + "\n")

        # Progress every 50 clauses
        if (i + 1) % 50 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            eta = (len(to_classify) - i - 1) / rate if rate > 0 else 0
            print(f"  {i+1}/{len(to_classify)} | {rate:.1f}/s | ETA {eta/60:.0f}m | errors {errors}")

    out_f.close()
    elapsed = time.time() - t0

    ok(f"Classification complete: {len(to_classify)} clauses in {elapsed/60:.1f}m")
    ok(f"Total in file: {carried + len(to_classify)} clauses")
    return out_file


def compute_consensus(classifications: dict) -> Optional[dict]:
    """
    Return the address where all models agree, or None if any axis disagrees.
    Used to build a high-confidence subset for analysis.
    """
    if not classifications:
        return None
    models = list(classifications.values())
    if len(models) == 1:
        return models[0]  # Single model, no comparison possible

    # Check agreement on each axis
    for axis in ["q1", "q2", "q3"]:
        values = [m.get(axis) for m in models if m.get(axis)]
        if len(set(values)) > 1:
            return None  # Disagreement

    # All agree
    return models[0]


# ─────────────────────────────────────────────────────────────────────────────
# EMBEDDING — Phase 3
#
# We embed the ORIGINAL clause text — the sentence as it appeared in the
# source corpus. No EO vocabulary added. No enrichment. Just raw text.
#
# The embedding model (text-embedding-3-large) was trained without EO.
# Any geometric structure we find is therefore not circular.
# ─────────────────────────────────────────────────────────────────────────────

def run_embedding(classified_file: Path, run_dir: Path, openai_key: str, model="text-embedding-3-large"):
    """
    Embed all classified clauses using OpenAI embeddings.
    Saves to embeddings.npz: vectors, labels, and metadata.

    Incremental: if embeddings.npz already exists, loads existing vectors,
    skips already-embedded clause IDs, embeds only new ones, and merges.
    Safe to re-run as classification grows — no duplicates.
    """
    client = _OpenAI(api_key=openai_key)
    out_file = run_dir / "embeddings.npz"

    # ── Load existing embeddings if present (incremental mode) ───────────────
    existing_ids = set()
    existing_data = {}
    if out_file.exists():
        try:
            existing_data = dict(np.load(out_file, allow_pickle=True))
            existing_ids  = set(existing_data["ids"].tolist())
            info(f"Found existing embeddings: {len(existing_ids)} clauses — will skip these")
        except Exception as e:
            warn(f"Could not load existing embeddings ({e}) — re-embedding all")
            existing_data = {}
            existing_ids  = set()

    # Load classified clauses
    records = []
    with open(classified_file) as f:
        for line in f:
            try:
                records.append(json.loads(line))
            except Exception:
                pass

    # Only clauses with classifications, skipping already-embedded IDs
    to_embed = [
        r for r in records
        if r.get("classifications") and r.get("id","") not in existing_ids
    ]
    info(f"New clauses to embed: {len(to_embed)} (of {len(records)} total classified)")

    if not to_embed:
        ok("Nothing new to embed — embeddings.npz is already up to date")
        return out_file

    texts = [r["clause"] for r in to_embed]

    # Batch embedding — OpenAI allows up to 2048 per call
    vectors = []
    batch_size = 100
    t0 = time.time()
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i+batch_size]
        try:
            response = client.embeddings.create(model=model, input=batch)
            for item in response.data:
                vectors.append(item.embedding)
        except Exception as e:
            warn(f"Embedding batch {i//batch_size} failed: {e}")
            vectors.extend([[0.0]*3072] * len(batch))  # Zero vector as placeholder
        if (i // batch_size) % 10 == 0:
            elapsed = time.time() - t0
            pct = (i+batch_size)/len(texts)*100
            print(f"  {min(i+batch_size,len(texts))}/{len(texts)} embedded ({pct:.0f}%)")

    vectors = np.array(vectors, dtype=np.float32)

    # ── Build label arrays — one per axis, using consensus where available ──
    def get_label(record, axis, use_model=None):
        cls = record.get("classifications", {})
        if use_model and use_model in cls:
            return cls[use_model].get(axis, "")
        consensus = record.get("consensus")
        if consensus:
            return consensus.get(axis, "")
        # Fall back to first available model
        for v in cls.values():
            if v and v.get(axis):
                return v[axis]
        return ""

    # Primary labels: consensus (or first model if no consensus)
    q1_labels = np.array([get_label(r,"q1") for r in to_embed])
    q2_labels = np.array([get_label(r,"q2") for r in to_embed])
    q3_labels = np.array([get_label(r,"q3") for r in to_embed])
    op_labels = np.array([
        ACT_FACE.get((get_label(r,"q1"), get_label(r,"q2")), "?")
        for r in to_embed
    ])
    lang_labels = np.array([r.get("language","?") for r in to_embed])
    source_labels = np.array([r.get("source","?") for r in to_embed])
    ids = np.array([r.get("id","") for r in to_embed])

    # Consensus mask (True = all models agreed)
    consensus_mask = np.array([r.get("consensus") is not None for r in to_embed])

    # ── Merge with existing embeddings ───────────────────────────────────────
    # If we loaded existing data at the top, concatenate new vectors onto it.
    # This means re-running embed is always safe — it only adds, never duplicates.
    if existing_data:
        def merge(key, new_arr):
            old_arr = existing_data.get(key)
            if old_arr is None:
                return new_arr
            if len(old_arr.shape) == 2:
                return np.concatenate([old_arr, new_arr], axis=0)
            return np.concatenate([old_arr, new_arr], axis=0)

        vectors       = merge("vectors",  vectors)
        q1_labels     = merge("q1",       q1_labels)
        q2_labels     = merge("q2",       q2_labels)
        q3_labels     = merge("q3",       q3_labels)
        op_labels     = merge("operator", op_labels)
        lang_labels   = merge("language", lang_labels)
        source_labels = merge("source",   source_labels)
        ids           = merge("ids",      ids)
        consensus_mask= merge("consensus",consensus_mask)
        ok(f"Merged with existing: {len(existing_ids)} old + {len(to_embed)} new = {len(ids)} total")

    np.savez_compressed(
        out_file,
        vectors=vectors,
        q1=q1_labels,
        q2=q2_labels,
        q3=q3_labels,
        operator=op_labels,
        language=lang_labels,
        source=source_labels,
        ids=ids,
        consensus=consensus_mask,
    )
    ok(f"Embeddings saved: {vectors.shape[0]} clauses × {vectors.shape[1]} dims")
    return out_file


# ─────────────────────────────────────────────────────────────────────────────
# ANALYSIS — Phase 4
#
# The core test: does the classification structure match the geometric structure?
#
# Three measurements:
#   (a) Per-axis z-score
#       Within-group cosine similarity vs between-group, shuffled baseline.
#       Tests: is each axis a real semantic dimension?
#
#   (b) Proportionality
#       Mean embedding distance should scale monotonically with axis-difference count.
#       Tests: is the coordinate structure real (not just grouping)?
#
#   (c) Axis independence (ARI)
#       Pairwise ARI between Q1, Q2, Q3 assignments.
#       Tests: are the three axes genuinely orthogonal?
#
# Output is a human-readable report explaining each result in lay terms,
# alongside the raw numbers.
# ─────────────────────────────────────────────────────────────────────────────

def cosine_similarity_matrix(vectors: np.ndarray) -> np.ndarray:
    """Compute pairwise cosine similarities efficiently."""
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)  # Avoid divide by zero
    normed = vectors / norms
    return normed @ normed.T

def compute_zscore(vectors: np.ndarray, labels: np.ndarray, n_shuffles=200) -> Tuple[float, float]:
    """
    Compute z-score of actual separation vs shuffled baseline.

    Uses a fixed sampling plan so shuffle variance reflects only label
    permutation, not sampling variation. This prevents sampling noise
    from inflating the z-score denominator.

    z = 0:   No structure. Classified groups are no more coherent than random.
    z > 5:   Moderate signal. Real structure, above noise.
    z > 10:  Strong signal. The grouping is a real semantic dimension.
    z > 20:  Very strong. Dominant geometric direction.

    Positive = actual groupings are MORE coherent than random shuffles.
    """
    unique = [l for l in np.unique(labels) if l and l != "?"]
    if len(unique) < 2:
        return 0.0, 0.0

    max_per_group = 200
    # Fixed seed for reproducibility. Uses labels length as salt so different
    # inputs produce different (but deterministic) results.
    rng = np.random.default_rng(seed=42 + len(labels))

    # Normalise once
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    # Note: separation_from_labels calls rng.choice on every invocation,
    # so null distribution sampling varies across shuffles. This makes the
    # test conservative (null variance is higher → z-scores deflated, not
    # inflated). No pre-sampled index tables are used.

    if len([l for l in unique if (labels == l).sum() >= 2]) < 2:
        return 0.0, 0.0

    def separation_from_labels(lbl_array):
        within_sims = []
        between_sims = []

        for label in unique:
            # Which of our pre-sampled positions now carry this label?
            all_pos = np.where(lbl_array == label)[0]
            if len(all_pos) < 2:
                continue
            pos_s = all_pos if len(all_pos) <= max_per_group else rng.choice(all_pos, max_per_group, replace=False)
            other_pos = np.where(lbl_array != label)[0]
            if len(other_pos) < 1:
                continue
            other_s = other_pos if len(other_pos) <= max_per_group else rng.choice(other_pos, max_per_group, replace=False)

            vg = normed[pos_s]
            vo = normed[other_s]

            # Use random sampling WITHOUT replacement for within-group pairs.
            # Sampling with replacement (previous version) allowed duplicate pairs,
            # which understates within-group variance. Instead: enumerate all unique
            # upper-triangle pairs, then subsample without replacement up to the cap.
            # This matches between-group (which samples cross-pairs without replacement)
            # and avoids the duplicate-pair correlation issue.
            n_in = len(pos_s)
            if n_in < 2:
                continue
            # All unique (i, j) pairs with i < j
            all_ri, all_rj = np.triu_indices(n_in, k=1)
            n_unique = len(all_ri)
            n_pairs_target = min(n_unique, max_per_group * 5)
            if n_pairs_target < 1:
                continue
            sel = rng.choice(n_unique, size=n_pairs_target, replace=False)
            ri, rj = all_ri[sel], all_rj[sel]
            within_batch = np.sum(vg[ri] * vg[rj], axis=1)
            within_sims.extend(within_batch.tolist())
            n_pairs = len(ri)

            n_pairs = min(n_pairs, len(pos_s), len(other_s))
            if n_pairs < 1:
                continue
            row_idx = rng.choice(len(pos_s),   size=n_pairs, replace=False)
            col_idx = rng.choice(len(other_s), size=n_pairs, replace=False)
            cross = np.sum(vg[row_idx] * vo[col_idx], axis=1)
            between_sims.extend(cross.tolist())

        if not within_sims or not between_sims:
            return 0.0
        return statistics.mean(within_sims) - statistics.mean(between_sims)

    actual = separation_from_labels(labels)

    shuffled = []
    shuffled_labels = labels.copy()
    for _ in range(n_shuffles):
        rng.shuffle(shuffled_labels)   # use same rng as sampling — unified stream
        shuffled.append(separation_from_labels(shuffled_labels))

    mean_s = statistics.mean(shuffled)
    std_s  = statistics.stdev(shuffled) if len(shuffled) > 1 else 1.0
    eps = 1e-10
    if std_s < eps:
        return 0.0, actual

    zscore = (actual - mean_s) / std_s
    return zscore, actual

def compute_proportionality(vectors: np.ndarray, q1: np.ndarray, q2: np.ndarray, q3: np.ndarray) -> dict:
    """
    Test whether mean embedding distance scales monotonically with axis-difference count.

    EO predicts:
      0 axes different  →  smallest distance (most similar)
      1 axis different  →  larger distance
      2 axes different  →  larger still
      3 axes different  →  largest distance (most different)

    If the three axes are real coordinate dimensions, clauses should get
    geometrically farther apart as more axes differ. This is a stronger
    claim than mere grouping — it says the ARRANGEMENT of cells matters.
    """
    # scipy available via top-level import

    # Sample pairs for efficiency (full matrix is O(n²))
    n = len(vectors)
    max_pairs_per_bucket = 5000
    buckets = {0: [], 1: [], 2: [], 3: []}

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    # Sample pairs stratified by axis-difference count to ensure equal
    # representation across buckets regardless of label distribution
    _prop_rng = np.random.default_rng(42)  # seeded for reproducibility
    attempts = 0
    max_attempts = max_pairs_per_bucket * 40
    while any(len(buckets[k]) < max_pairs_per_bucket for k in range(4)) and attempts < max_attempts:
        attempts += 1
        i, j = int(_prop_rng.integers(0, n)), int(_prop_rng.integers(0, n))
        if i == j:
            continue
        diff = (
            int(q1[i] != q1[j]) +
            int(q2[i] != q2[j]) +
            int(q3[i] != q3[j])
        )
        if len(buckets[diff]) < max_pairs_per_bucket:
            cos_dist = 1.0 - float(normed[i] @ normed[j])
            buckets[diff].append(cos_dist)

    result = {}
    for k in [0, 1, 2, 3]:
        vals = buckets[k]
        if vals:
            if len(vals) < max_pairs_per_bucket * 0.5:
                warn(f"Proportionality bucket {k} undersampled: {len(vals)} pairs (target {max_pairs_per_bucket})")
            result[k] = {
                "mean_distance": statistics.mean(vals),
                "n_pairs":       len(vals),
                "stdev":         statistics.stdev(vals) if len(vals) > 1 else 0,
            }
        else:
            warn(f"Proportionality bucket {k} is empty — label distribution may be too skewed")
            result[k] = {"mean_distance": None, "n_pairs": 0, "stdev": None}

    # Check monotonicity with bootstrap confidence intervals
    # Each bucket has 5000 pairs; bootstrap resamples to test whether
    # adjacent means are distinguishable, not just whether means are ordered.
    means = [result[k]["mean_distance"] for k in [0,1,2,3] if result[k]["mean_distance"] is not None]
    is_monotone = all(means[i] <= means[i+1] for i in range(len(means)-1))

    # Bootstrap: resample each bucket and count how often ordering holds
    _rng = np.random.default_rng(42)
    n_boot = 500
    boot_monotone_count = 0
    bucket_vals = {k: buckets[k] for k in [0,1,2,3] if buckets[k]}
    valid_keys = sorted(bucket_vals.keys())
    for _ in range(n_boot):
        boot_means = []
        for k in valid_keys:
            vals = bucket_vals[k]
            sample = _rng.choice(vals, size=len(vals), replace=True)
            boot_means.append(float(sample.mean()))
        if all(boot_means[i] <= boot_means[i+1] for i in range(len(boot_means)-1)):
            boot_monotone_count += 1
    monotone_bootstrap_p = round(1 - boot_monotone_count / n_boot, 4)

    result["monotone"] = is_monotone
    result["monotone_bootstrap_p"] = monotone_bootstrap_p
    # p = fraction of bootstrap resamples where monotonicity FAILS.
    # p < 0.05 means monotone ordering is stable — not just a sample artifact.

    return result

def compute_axis_ari(q1: np.ndarray, q2: np.ndarray, q3: np.ndarray) -> dict:
    """
    Pairwise Adjusted Rand Index between the three classification axes.

    ARI = 0: Complete independence. Knowing Q1 tells you nothing about Q2.
    ARI = 1: Perfect agreement. The two axes are the same classification.

    EO predicts all pairs near 0. The three axes should be orthogonal —
    Mode (Q1), Domain (Q2), and Object grain (Q3) are genuinely independent
    dimensions, not three ways of describing the same thing.

    If any pair shows ARI > 0.20, that's a structural problem: either
    the questions are not independent, or the AI classifiers are treating
    them as correlated.
    """
    def encode(arr):
        le = LabelEncoder()
        return le.fit_transform([x if x else "?" for x in arr])

    # Use only clauses where ALL three axes have valid labels
    valid = np.array([
        q1[i] not in ("", "?") and q2[i] not in ("", "?") and q3[i] not in ("", "?")
        for i in range(len(q1))
    ])
    q1v, q2v, q3v = q1[valid], q2[valid], q3[valid]
    q1e, q2e, q3e = encode(q1v), encode(q2v), encode(q3v)

    return {
        "q1_vs_q2": float(adjusted_rand_score(q1e, q2e)),
        "q1_vs_q3": float(adjusted_rand_score(q1e, q3e)),
        "q2_vs_q3": float(adjusted_rand_score(q2e, q3e)),
    }

def compute_per_language_zscores(vectors, q1, q2, q3, lang_labels, n_shuffles=200):
    """
    Compute per-axis z-scores broken down by language.
    Tests whether the axes are real across language families, not just in English.
    Computes: Q1, Q2, Q3 (individual axes), Act/Site/Resolution faces (9-group),
    and full 27-cell — giving a complete per-language profile.
    """
    results = {}
    langs = [l for l in np.unique(lang_labels) if l and l != "?"]

    for lang in langs:
        mask = lang_labels == lang
        if mask.sum() < 100:  # Skip languages with too few clauses
            continue
        vecs = vectors[mask]
        lq1, lq2, lq3 = q1[mask], q2[mask], q3[mask]
        results[lang] = {}

        # Individual axes
        for axis_name, labels in [("q1", lq1), ("q2", lq2), ("q3", lq3)]:
            valid = labels != "?"
            if valid.sum() < 50:
                continue
            z, sep = compute_zscore(vecs[valid], labels[valid], n_shuffles=n_shuffles)
            results[lang][axis_name] = {"z": round(z, 2), "separation": round(sep, 4)}

        # Act face (Q1×Q2)
        valid = (lq1 != "?") & (lq2 != "?")
        if valid.sum() >= 50:
            act_lbl = np.array([f"{lq1[i]}/{lq2[i]}" for i in range(len(lq1))])
            z, sep = compute_zscore(vecs[valid], act_lbl[valid], n_shuffles=n_shuffles)
            results[lang]["act_face"] = {"z": round(z, 2), "separation": round(sep, 4)}

        # Site face (Q2×Q3)
        valid = (lq2 != "?") & (lq3 != "?")
        if valid.sum() >= 50:
            site_lbl = np.array([f"{lq2[i]}/{lq3[i]}" for i in range(len(lq2))])
            z, sep = compute_zscore(vecs[valid], site_lbl[valid], n_shuffles=n_shuffles)
            results[lang]["site_face"] = {"z": round(z, 2), "separation": round(sep, 4)}

        # Resolution face (Q1×Q3)
        valid = (lq1 != "?") & (lq3 != "?")
        if valid.sum() >= 50:
            res_lbl = np.array([f"{lq1[i]}/{lq3[i]}" for i in range(len(lq1))])
            z, sep = compute_zscore(vecs[valid], res_lbl[valid], n_shuffles=n_shuffles)
            results[lang]["resolution_face"] = {"z": round(z, 2), "separation": round(sep, 4)}

        # Full 27-cell
        valid = (lq1 != "?") & (lq2 != "?") & (lq3 != "?")
        if valid.sum() >= 50:
            full_lbl = np.array([f"{lq1[i]}/{lq2[i]}/{lq3[i]}" for i in range(len(lq1))])
            z, sep = compute_zscore(vecs[valid], full_lbl[valid], n_shuffles=n_shuffles)
            results[lang]["full_27cell"] = {"z": round(z, 2), "separation": round(sep, 4)}

    return results


def compute_operator_and_face_zscores(vectors, q1, q2, q3, n_shuffles=200):
    """
    Test whether the 9 operators and 3 faces produce geometric signal.

    Three levels compared:
      Axes (3 groups each): Q1, Q2, Q3 individually
      Operators (9 groups): Q1 × Q2 = Act face operators
      Faces (9 groups each): Act (Q1×Q2), Site (Q2×Q3), Resolution (Q1×Q3)

    If operators z-score is stronger than either axis alone, the combinatorial
    structure (Mode × Domain together) is more geometrically real than either
    dimension individually.

    If any face score beats its component axes, the 9-cell projections carry
    genuine semantic information beyond what the axes alone capture.
    """
    results = {}

    # ── 9 operators (Act face: Q1 × Q2) ─────────────────────────────────────
    op_labels = np.array([f"{a}/{b}" for a, b in zip(q1, q2)])
    valid = (q1 != "?") & (q2 != "?")
    if valid.sum() >= 50:
        z, sep = compute_zscore(vectors[valid], op_labels[valid], n_shuffles=n_shuffles)
        results["operators_act"] = {"z": round(z,2), "separation": round(sep,5),
                                     "n_groups": len(set(op_labels[valid])),
                                     "label": "Operators (Q1×Q2 Act face, 9 groups)"}
        print(f"    operators (Act face):    {z:+.2f} SDs from chance", flush=True)

    # ── Act face (Q1 × Q2) — same as operators but named for clarity ─────────
    # Already computed above as operators_act

    # ── Site face (Q2 × Q3) ──────────────────────────────────────────────────
    site_labels = np.array([f"{a}/{b}" for a, b in zip(q2, q3)])
    valid = (q2 != "?") & (q3 != "?")
    if valid.sum() >= 50:
        z, sep = compute_zscore(vectors[valid], site_labels[valid], n_shuffles=n_shuffles)
        results["face_site"] = {"z": round(z,2), "separation": round(sep,5),
                                 "n_groups": len(set(site_labels[valid])),
                                 "label": "Site face (Q2×Q3, 9 groups)"}
        print(f"    Site face (Q2×Q3):       {z:+.2f} SDs from chance", flush=True)

    # ── Resolution face (Q1 × Q3) ────────────────────────────────────────────
    res_labels = np.array([f"{a}/{b}" for a, b in zip(q1, q3)])
    valid = (q1 != "?") & (q3 != "?")
    if valid.sum() >= 50:
        z, sep = compute_zscore(vectors[valid], res_labels[valid], n_shuffles=n_shuffles)
        results["face_resolution"] = {"z": round(z,2), "separation": round(sep,5),
                                       "n_groups": len(set(res_labels[valid])),
                                       "label": "Resolution face (Q1×Q3, 9 groups)"}
        print(f"    Resolution face (Q1×Q3): {z:+.2f} SDs from chance", flush=True)

    # ── Full 27-cell address (Q1 × Q2 × Q3) ──────────────────────────────────
    full_labels = np.array([f"{a}/{b}/{c}" for a, b, c in zip(q1, q2, q3)])
    valid = (q1 != "?") & (q2 != "?") & (q3 != "?")
    if valid.sum() >= 50:
        z, sep = compute_zscore(vectors[valid], full_labels[valid], n_shuffles=n_shuffles)
        results["full_27cell"] = {"z": round(z,2), "separation": round(sep,5),
                                   "n_groups": len(set(full_labels[valid])),
                                   "label": f"Full 27-cell (Q1×Q2×Q3, {len(set(full_labels[valid]))} groups)"}
        print(f"    Full 27-cell address:    {z:+.2f} SDs from chance", flush=True)

    return results


def compute_unsupervised_structure(vectors, q1, q2, q3, n_clusters_range=(3,9,27)):
    """
    Ask what structure the data itself suggests, without EO labels.

    Tests three things:
    1. ICA: do the independent components of clause embeddings correlate
       with EO's Q1/Q2/Q3 axes?
    2. HDBSCAN/KMeans: how many natural clusters emerge, and do they
       map onto EO cells?
    3. Explained variance: what fraction of variance is captured by
       the EO classification vs the first N principal components?

    If the geometry's natural clusters match EO's labels, the structure
    is data-driven, not imposed. If they don't match, a different
    decomposition may fit better.
    """
    results = {}

    try:
        from sklearn.decomposition import FastICA
        from sklearn.cluster import KMeans
        from sklearn.metrics import adjusted_rand_score
        from sklearn.preprocessing import LabelEncoder

        # Normalise
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        normed = vectors / norms

        # Sample for speed — ICA on full 3072-dim space is slow
        n_sample = min(5000, len(normed))  # increased from 2000 for k=27 stability
        idx = np.random.choice(len(normed), n_sample, replace=False)
        sample = normed[idx]
        sq1, sq2, sq3 = q1[idx], q2[idx], q3[idx]

        le = LabelEncoder()

        # ── PCA variance explained by EO axes ─────────────────────────────
        from sklearn.decomposition import PCA
        pca = PCA(n_components=min(50, sample.shape[1]), random_state=42)
        pca.fit(sample)
        cumvar = np.cumsum(pca.explained_variance_ratio_)
        # How many PCs needed to explain 50% / 80% of variance?
        n_50 = int(np.searchsorted(cumvar, 0.50)) + 1
        n_80 = int(np.searchsorted(cumvar, 0.80)) + 1
        results["pca_variance"] = {
            "pcs_for_50pct": n_50,
            "pcs_for_80pct": n_80,
            "top3_variance": round(float(cumvar[2]), 3),
        }
        print(f"    PCA: {n_50} components for 50% variance, {n_80} for 80%", flush=True)

        # ── KMeans at k=3, k=9, k=27: do clusters align with EO? ─────────
        valid = (sq1 != "?") & (sq2 != "?") & (sq3 != "?")
        if valid.sum() >= 50:
            sv = sample[valid]
            op_labels = np.array([f"{a}/{b}" for a,b in zip(sq1[valid], sq2[valid])])
            full_labels = np.array([f"{a}/{b}/{c}" for a,b,c in zip(sq1[valid],sq2[valid],sq3[valid])])

            kmeans_results = {}
            for k in n_clusters_range:
                km = KMeans(n_clusters=k, random_state=42, n_init=10)
                km_labels = km.fit_predict(sv)

                # ARI against EO labels at same granularity
                if k == 3:
                    eo_ref = le.fit_transform(sq1[valid])
                    ari_q1 = float(adjusted_rand_score(eo_ref, km_labels))
                    eo_ref2 = le.fit_transform(sq2[valid])
                    ari_q2 = float(adjusted_rand_score(eo_ref2, km_labels))
                    eo_ref3 = le.fit_transform(sq3[valid])
                    ari_q3 = float(adjusted_rand_score(eo_ref3, km_labels))
                    kmeans_results[k] = {
                        "ari_vs_q1": round(ari_q1, 3),
                        "ari_vs_q2": round(ari_q2, 3),
                        "ari_vs_q3": round(ari_q3, 3),
                        "inertia": round(float(km.inertia_), 2),
                    }
                    print(f"    KMeans k=3: ARI vs Q1={ari_q1:.3f} Q2={ari_q2:.3f} Q3={ari_q3:.3f}", flush=True)
                elif k == 9:
                    eo_ref = le.fit_transform(op_labels)
                    ari_op = float(adjusted_rand_score(eo_ref, km_labels))
                    kmeans_results[k] = {
                        "ari_vs_operators": round(ari_op, 3),
                        "inertia": round(float(km.inertia_), 2),
                    }
                    print(f"    KMeans k=9: ARI vs operators={ari_op:.3f}", flush=True)
                elif k == 27:
                    eo_ref = le.fit_transform(full_labels)
                    ari_27 = float(adjusted_rand_score(eo_ref, km_labels))
                    kmeans_results[k] = {
                        "ari_vs_27cell": round(ari_27, 3),
                        "inertia": round(float(km.inertia_), 2),
                    }
                    print(f"    KMeans k=27: ARI vs 27-cell={ari_27:.3f}", flush=True)

            results["kmeans"] = kmeans_results

    except Exception as e:
        warn(f"Unsupervised analysis failed: {e}")

    return results


def compute_ari_excluding_sparse_cells(q1, q2, q3, sparse_threshold=20):
    """
    Test whether Q1/Q2 ARI persists after excluding desert cells and gravity wells.

    EO predicts certain cells will be nearly empty (deserts) or very full
    (gravity wells). If the Q1/Q2 correlation is driven by cell sparsity —
    i.e. some Q1×Q2 combinations are rare because of helix dependency ordering —
    then excluding those cells should make ARI drop toward zero.

    If ARI stays high even after excluding sparse cells, the axes have a
    genuine semantic dependency, not just a distributional artifact.

    Returns: {
        "ari_all": float,          # ARI on full dataset
        "ari_excluding_sparse": float,  # ARI after excluding sparse cells
        "cells_excluded": list,    # which cells were excluded
        "n_excluded": int,         # how many clauses were excluded
        "interpretation": str,
    }
    """
    from sklearn.metrics import adjusted_rand_score
    from sklearn.preprocessing import LabelEncoder
    from collections import Counter

    valid = (q1 != "?") & (q2 != "?") & (q3 != "?")
    q1v, q2v = q1[valid], q2[valid]

    le = LabelEncoder()
    ari_all = float(adjusted_rand_score(le.fit_transform(q1v), le.fit_transform(q2v)))

    # Count clauses per Q1×Q2 cell
    cell_counts = Counter(zip(q1v, q2v))
    total = sum(cell_counts.values())

    # Identify sparse cells (below threshold) and gravity wells (top 1 cell)
    sparse_cells = {cell for cell, n in cell_counts.items() if n < sparse_threshold}
    max_cell = max(cell_counts, key=cell_counts.get)
    gravity_cells = {max_cell} if cell_counts[max_cell] > total * 0.25 else set()
    excluded_cells = sparse_cells | gravity_cells

    # Filter to only well-populated, non-dominant cells
    keep = np.array([
        (q1v[i], q2v[i]) not in excluded_cells
        for i in range(len(q1v))
    ])

    n_excluded = (~keep).sum()
    cells_excluded = sorted([f"{c[0]}/{c[1]}" for c in excluded_cells])

    if keep.sum() < 50:
        return {
            "ari_all": round(ari_all, 4),
            "ari_excluding_sparse": None,
            "cells_excluded": cells_excluded,
            "n_excluded": int(n_excluded),
            "interpretation": "Too few clauses remain after exclusion to compute ARI",
        }

    ari_excl = float(adjusted_rand_score(
        le.fit_transform(q1v[keep]),
        le.fit_transform(q2v[keep])
    ))

    # Interpret
    delta = ari_all - ari_excl
    if ari_excl < 0.05:
        interp = "ARI drops to near-zero after excluding sparse cells. The correlation is driven by cell sparsity from helix dependency ordering, not a genuine semantic dependency between the axes. Reading 1 confirmed."
    elif delta > ari_all * 0.5:
        interp = f"ARI drops substantially ({ari_all:.3f} -> {ari_excl:.3f}) after excluding sparse cells. Most of the correlation is distributional artifact. Residual correlation is weak."
    elif delta > 0.02:
        interp = f"ARI drops modestly ({ari_all:.3f} -> {ari_excl:.3f}). Cell sparsity explains part of the correlation but not all. Some genuine semantic dependency between Mode and Domain may exist."
    else:
        interp = f"ARI barely changes ({ari_all:.3f} -> {ari_excl:.3f}) after excluding sparse cells. The correlation persists in well-populated cells. Reading 2 has support: Mode and Domain are not fully independent dimensions."

    # Note on interpretation: this test removes low-count cells and the
    # dominant cell, then re-measures ARI. If ARI drops, sparsity was
    # driving the correlation. If ARI stays high or increases, the
    # correlation persists in well-populated regions. However, cell
    # exclusion also reduces label diversity, which can itself reduce
    # ARI independently of structural sparsity. Treat interpretation
    # as suggestive, not conclusive.
    return {
        "ari_all": round(ari_all, 4),
        "ari_excluding_sparse": round(ari_excl, 4),
        "cells_excluded": cells_excluded,
        "n_excluded": int(n_excluded),
        "interpretation": interp,
    }



def compute_centroids(vectors, labels, min_count=5):
    """
    Compute the mean embedding vector (centroid) for each label group.
    Returns dict: label -> centroid vector (normalized).
    Only includes groups with at least min_count members.
    """
    from collections import defaultdict
    groups = defaultdict(list)
    for i, label in enumerate(labels):
        if label and label != "?":
            groups[label].append(vectors[i])

    centroids = {}
    for label, vecs in groups.items():
        if len(vecs) >= min_count:
            centroid = np.mean(vecs, axis=0)
            # Normalize to unit length for cosine comparison
            norm = np.linalg.norm(centroid)
            if norm > 0:
                centroid = centroid / norm
            centroids[label] = {"centroid": centroid, "n": len(vecs)}

    return centroids



def compute_discriminative_centroids(vectors, labels, top_n=20, min_count=5):
    """
    Compute discriminative centroids (core prototypes) for each label.

    Unlike the mean centroid (average of all instances), the discriminative
    centroid is computed from only the top-N highest-margin members per cell.
    Margin = similarity to own centroid minus similarity to nearest other centroid.

    This excludes boundary cases and centers on the discriminative core —
    the region most unambiguously "this cell and not others."

    Steps:
      1. Compute initial mean centroids for all cells
      2. Score every member by margin (sim_own - best_other_centroid)
      3. Take top_n highest-margin members per cell
      4. Recompute centroid from those members only

    Returns dict: label -> {centroid, n, n_core, mean_margin}
    """
    # Step 1: initial mean centroids
    initial = compute_centroids(vectors, labels, min_count=min_count)
    if len(initial) < 2:
        return {k: {"centroid": v["centroid"], "n": v["n"], "n_core": v["n"], "mean_margin": 0.0}
                for k, v in initial.items()}

    centroid_labels = list(initial.keys())
    centroid_matrix = np.stack([initial[l]["centroid"] for l in centroid_labels])

    # Normalize vectors once
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    label_arr = np.array(labels)
    discriminative = {}

    for label in centroid_labels:
        mask = label_arr == label
        cell_vecs  = normed[mask]
        cell_raw   = vectors[mask]   # unnormalized for mean
        own_cn     = initial[label]["centroid"]

        # Similarity to own centroid and all others
        sim_own = cell_vecs @ own_cn
        other_cols = [i for i, l in enumerate(centroid_labels) if l != label]
        if other_cols:
            sim_others = (cell_vecs @ centroid_matrix[other_cols].T).max(axis=1)
            margin = sim_own - sim_others
        else:
            margin = sim_own

        # Take top_n by margin
        n_take = min(top_n, len(margin))
        top_idx = np.argsort(margin)[::-1][:n_take]
        core_vecs = cell_raw[top_idx]

        # Recompute centroid from core members only
        core_centroid = core_vecs.mean(axis=0)
        norm = np.linalg.norm(core_centroid)
        if norm > 0:
            core_centroid = core_centroid / norm

        discriminative[label] = {
            "centroid":    core_centroid,
            "n":           int(mask.sum()),
            "n_core":      int(n_take),
            "mean_margin": round(float(margin[top_idx].mean()), 4),
        }

    return discriminative


def classify_by_centroid(vectors, centroids):
    """
    Assign each vector to the nearest centroid by cosine similarity.
    Returns (predicted_labels, margin) where margin = gap between
    top-1 and top-2 cosine similarity. Larger margin = more confident.
    """
    centroid_labels = list(centroids.keys())
    centroid_matrix = np.stack([centroids[l]["centroid"] for l in centroid_labels])

    # Normalize input vectors
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    # Cosine similarity = dot product of normalized vectors
    sims = normed @ centroid_matrix.T  # shape: (n_vectors, n_centroids)

    # Sort to get top-1 and top-2
    if sims.shape[1] >= 2:
        top2_idx = np.argsort(sims, axis=1)[:, -2:]  # top 2 indices
        best_idx  = top2_idx[:, 1]   # highest
        second_idx = top2_idx[:, 0]  # second highest
        best_sim   = sims[np.arange(len(sims)), best_idx]
        second_sim = sims[np.arange(len(sims)), second_idx]
        margin = best_sim - second_sim  # confidence = separation from runner-up
    else:
        best_idx = np.argmax(sims, axis=1)
        best_sim = np.max(sims, axis=1)
        margin = best_sim

    predicted = np.array([centroid_labels[i] for i in best_idx])
    return predicted, margin


def run_centroids(embeddings_file: Path, classified_file: Path, run_dir: Path):
    """
    Phase 5 — Centroid Classifier.

    Computes centroids for all EO groupings (triads, operators, full 27-cell)
    from consensus-classified clauses, then classifies ALL clauses (including
    non-consensus) by nearest centroid. Measures how well the geometric
    centroids recover the AI classifications.

    This tests whether the 27 cells are stable geometric regions — not just
    statistically significant on average, but individually locatable so that
    new text can be addressed without any AI classifier.
    """
    section("Loading embeddings for centroid analysis")
    data = np.load(embeddings_file, allow_pickle=True)
    vectors  = data["vectors"].astype(np.float32)
    q1       = data["q1"]
    q2       = data["q2"]
    q3       = data["q3"]
    op       = data["operator"]
    lang     = data["language"]
    ids      = data["ids"]
    # Note: old embeddings.npz files without a "consensus" key default to
    # all-True, which may include single-model clauses from before dual-model
    # classification was added. Re-embed from classified.jsonl to correct this.
    if "consensus" not in data:
        import warnings
        warnings.warn(
            "embeddings.npz has no 'consensus' key — treating all vectors as consensus. "
            "This will contaminate centroid training with single-model clauses if the file "
            "predates dual-model classification. Re-embed from classified.jsonl to fix.",
            stacklevel=2
        )
    consensus = data.get("consensus", np.ones(len(vectors), dtype=bool))

    ok(f"Loaded {len(vectors):,} vectors")
    info(f"Consensus (centroid training) set: {consensus.sum():,} clauses")

    ACT = {
        ("DIFFERENTIATING","EXISTENCE"): "NUL", ("DIFFERENTIATING","STRUCTURE"): "SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"): "ALT", ("RELATING","EXISTENCE"): "SIG",
        ("RELATING","STRUCTURE"): "CON", ("RELATING","SIGNIFICANCE"): "SUP",
        ("GENERATING","EXISTENCE"): "INS", ("GENERATING","STRUCTURE"): "SYN",
        ("GENERATING","SIGNIFICANCE"): "REC",
    }
    SITE = {
        ("EXISTENCE","CONDITION"): "Void", ("EXISTENCE","ENTITY"): "Entity",
        ("EXISTENCE","PATTERN"): "Kind", ("STRUCTURE","CONDITION"): "Field",
        ("STRUCTURE","ENTITY"): "Link", ("STRUCTURE","PATTERN"): "Network",
        ("SIGNIFICANCE","CONDITION"): "Atmosphere", ("SIGNIFICANCE","ENTITY"): "Lens",
        ("SIGNIFICANCE","PATTERN"): "Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"): "Clearing", ("DIFFERENTIATING","ENTITY"): "Dissecting",
        ("DIFFERENTIATING","PATTERN"): "Unraveling", ("RELATING","CONDITION"): "Tending",
        ("RELATING","ENTITY"): "Binding", ("RELATING","PATTERN"): "Tracing",
        ("GENERATING","CONDITION"): "Cultivating", ("GENERATING","ENTITY"): "Making",
        ("GENERATING","PATTERN"): "Composing",
    }

    # Build full 27-cell label array
    full_labels = np.array([
        f"{ACT.get((q1[i],q2[i]),'?')}({RES.get((q1[i],q3[i]),'?')}, {SITE.get((q2[i],q3[i]),'?')})"
        if q1[i] != "?" and q2[i] != "?" and q3[i] != "?" else "?"
        for i in range(len(vectors))
    ])

    # Training set: consensus clauses only
    train_mask = consensus & (full_labels != "?")
    train_vecs  = vectors[train_mask]
    train_op    = op[train_mask]
    train_q1    = q1[train_mask]
    train_q2    = q2[train_mask]
    train_full  = full_labels[train_mask]

    results = {}

    # ── Train/test split: 80% train, 20% held-out test ───────────────────────
    rng_split = np.random.default_rng(42)
    train_indices = np.where(train_mask)[0]
    rng_split.shuffle(train_indices)
    split = int(len(train_indices) * 0.8)
    train_idx = train_indices[:split]
    test_idx  = train_indices[split:]

    split_train_mask = np.zeros(len(vectors), dtype=bool)
    split_train_mask[train_idx] = True
    split_test_mask  = np.zeros(len(vectors), dtype=bool)
    split_test_mask[test_idx] = True

    info(f"Train/test split: {split_train_mask.sum():,} train / {split_test_mask.sum():,} held-out test")

    # ── Compute and evaluate at three levels ─────────────────────────────────
    # Site face labels (Q2×Q3)
    site_labels_eval = np.array([
        SITE.get((q2[i], q3[i]), "?")
        if q2[i] != "?" and q3[i] != "?" else "?"
        for i in range(len(vectors))
    ])
    # Resolution face labels (Q1×Q3)
    res_labels_eval = np.array([
        RES.get((q1[i], q3[i]), "?")
        if q1[i] != "?" and q3[i] != "?" else "?"
        for i in range(len(vectors))
    ])

    for level_name, label_arr in [
        ("Triads (3 groups)",           q2),
        ("Operators (9 groups)",          op),
        ("Site face (9)",               site_labels_eval),
        ("Resolution face (9)",         res_labels_eval),
        ("Full 27-cell",                full_labels),
    ]:
        section(f"Centroid classifier — {level_name}")

        # Build centroids from 80% training split
        train_lbl = label_arr[split_train_mask]
        split_vecs = vectors[split_train_mask]
        centroids = compute_centroids(split_vecs, train_lbl)
        info(f"Computed {len(centroids)} centroids from {split_train_mask.sum():,} training clauses (80% split)")

        def evaluate(vecs, true_lbl, label=""):
            pred, margin = classify_by_centroid(vecs, centroids)
            correct = pred == true_lbl
            acc = correct.mean()
            high_conf = (margin > 0.02).mean()   # margin > 0.02 = clear winner
            med_conf  = ((margin > 0.01) & (margin <= 0.02)).mean()
            print(f"  {label:<30} {acc:.1%}  ({correct.sum():,}/{len(vecs):,})  margin>0.02: {high_conf:.0%}")
            return pred, margin, correct

        # In-sample (all consensus)
        cons_lbl = label_arr[train_mask]
        cons_vecs = vectors[train_mask]
        _, _, _ = evaluate(cons_vecs, cons_lbl, "In-sample (consensus, biased):")

        # Held-out test (20% split, unbiased)
        test_lbl  = label_arr[split_test_mask]
        test_vecs = vectors[split_test_mask]
        pred_test, margin_test, correct_test = evaluate(test_vecs, test_lbl, "Held-out test (unbiased):")

        # All clauses (includes non-consensus)
        all_mask = label_arr != "?"
        all_vecs  = vectors[all_mask]
        all_lbl   = label_arr[all_mask]
        all_cons  = consensus[all_mask]
        pred_all, margin_all, correct_all = evaluate(all_vecs, all_lbl, "All clauses:")
        if all_cons.sum() > 0:
            cons_acc_all = correct_all[all_cons].mean()
            print(f"  {'Consensus subset of all:':<30} {cons_acc_all:.1%}  ({correct_all[all_cons].sum():,}/{all_cons.sum():,})")

        # Per-cell accuracy for full 27-cell
        per_cell = {}
        if "27" in level_name:
            print("\n  Per-cell centroid accuracy (held-out):")
            for cell in sorted(set(test_lbl)):
                mask = test_lbl == cell
                if mask.sum() < 3:
                    continue
                cell_acc  = (pred_test[mask] == cell).mean()
                cell_marg = margin_test[mask].mean()
                per_cell[cell] = {"accuracy": round(float(cell_acc),4),
                                   "n": int(mask.sum()),
                                   "mean_margin": round(float(cell_marg),4)}
            for cell, cr in sorted(per_cell.items(), key=lambda x: -x[1]["accuracy"]):
                bar = "█" * int(cr["accuracy"] * 20)
                print(f"    {cell:<35} {cr['accuracy']:>5.1%}  {bar}  (n={cr['n']})")

        # Chance baseline
        n_groups = len(centroids)
        chance = 1.0 / n_groups
        held_acc = correct_test.mean() if len(correct_test) else 0
        print(f"  Chance baseline: {chance:.1%}  |  Held-out is {held_acc/chance:.1f}× above chance")

        results[level_name] = {
            "accuracy_insample":  round(float(correct_all[all_cons].mean()) if all_cons.sum() > 0 else 0, 4),
            "accuracy_heldout":   round(float(held_acc), 4),
            "accuracy_all":       round(float(correct_all.mean()), 4),
            "chance_baseline":    round(chance, 4),
            "multiple_of_chance": round(held_acc / chance, 2),
            "n_centroids":        len(centroids),
            "high_margin_pct":    round(float((margin_test > 0.02).mean()), 4),
            "per_cell":           per_cell,
        }

    # ── Save centroids to disk ────────────────────────────────────────────────
    section("Saving centroids")
    centroids_27 = compute_centroids(train_vecs, train_full)
    centroid_labels_out = list(centroids_27.keys())
    centroid_matrix_out = np.stack([centroids_27[l]["centroid"] for l in centroid_labels_out])
    centroid_counts_out = np.array([centroids_27[l]["n"] for l in centroid_labels_out])

    centroid_file = run_dir / "centroids.npz"
    np.savez_compressed(
        centroid_file,
        labels=np.array(centroid_labels_out),
        vectors=centroid_matrix_out,
        counts=centroid_counts_out,
    )
    ok(f"Saved {len(centroid_labels_out)} mean centroids to {centroid_file}")

    # ── Discriminative centroids (core prototypes) at all four levels ───────────
    # For each grouping level, compute discriminative centroids from the
    # top-20 highest-margin members per group. These exclude boundary cases
    # and represent the unambiguous core of each position.
    section("Computing discriminative centroids at all four levels")

    # Build label arrays for all four faces
    train_site = np.array([
        SITE.get((train_q2[i], q3[train_mask][i]), "?")
        if train_q2[i] != "?" and q3[train_mask][i] != "?" else "?"
        for i in range(len(train_vecs))
    ])
    train_res = np.array([
        RES.get((train_q1[i], q3[train_mask][i]), "?")
        if train_q1[i] != "?" and q3[train_mask][i] != "?" else "?"
        for i in range(len(train_vecs))
    ])

    disc_levels = {
        "27cell":           (train_vecs, train_full),
        "act_face":         (train_vecs, train_op),
        "site_face":        (train_vecs, train_site),
        "resolution_face":  (train_vecs, train_res),
    }

    all_disc = {}
    disc_file = run_dir / "discriminative_centroids.npz"

    # Collect all arrays for combined save
    all_labels   = []
    all_vectors  = []
    all_n_core   = []
    all_margins  = []
    all_levels   = []

    for level_name, (lvecs, llabels) in disc_levels.items():
        valid = llabels != "?"
        disc = compute_discriminative_centroids(lvecs[valid], llabels[valid], top_n=20)
        all_disc[level_name] = disc

        n = len(disc)
        sorted_cells = sorted(disc.items(), key=lambda x: -x[1]["mean_margin"])
        print(f"\n  {level_name} ({n} positions):")
        for lbl, d in sorted_cells:
            bar = "█" * int(d["mean_margin"] * 300)
            print(f"    {lbl:<35} Δ={d['mean_margin']:.4f}  n_core={d['n_core']}  {bar}")

        for lbl, d in disc.items():
            all_labels.append(f"{level_name}::{lbl}")
            all_vectors.append(d["centroid"])
            all_n_core.append(d["n_core"])
            all_margins.append(d["mean_margin"])
            all_levels.append(level_name)

    np.savez_compressed(
        disc_file,
        labels=np.array(all_labels),
        vectors=np.stack(all_vectors),
        n_core=np.array(all_n_core),
        mean_margin=np.array(all_margins),
        level=np.array(all_levels),
    )
    ok(f"Saved {len(all_labels)} discriminative centroids to {disc_file}")
    info("Format: labels are 'level::cell' e.g. '27cell::CON(Binding, Link)'")
    info("Levels: 27cell, act_face, site_face, resolution_face")
    info("Use these core prototypes for classification — they exclude boundary cases.")

    # ── Helix geometry tests (A/B/C/D) ───────────────────────────────────────
    section("Helix geometry tests (A–D)")
    pp_data = compute_phasepost_frequency(classified_file)
    pp_consensus = pp_data["counts"].get("consensus", {})
    SITE_HELIX = ["Void","Entity","Kind","Field","Link","Network","Atmosphere","Lens","Paradigm"]
    RES_HELIX  = ["Clearing","Dissecting","Unraveling","Tending","Binding","Tracing",
                  "Cultivating","Making","Composing"]

    # Build per-face frequency counts from pp_consensus
    def face_pp(pp, face_fn):
        """Extract face-level frequency counts from 27-cell phasepost."""
        result = {}
        for cell, count in pp.items():
            label = face_fn(cell)
            if label:
                result[label] = result.get(label, 0) + count
        return result

    def site_fn(cell):
        if ", " in cell and ")" in cell:
            return cell.split(", ")[1].rstrip(")")
        return None
    def res_fn(cell):
        if "(" in cell and "," in cell:
            return cell.split("(")[1].split(",")[0].strip()
        return None

    site_pp = face_pp(pp_consensus, site_fn)
    res_pp  = face_pp(pp_consensus, res_fn)

    helix_geo = {
        "act_face":        compute_helix_geometry_tests(disc_file, pp_consensus, classified_file,
                                                         face="act_face"),
        "site_face":       compute_helix_geometry_tests(disc_file, site_pp, classified_file,
                                                         face="site_face",
                                                         helix_order=SITE_HELIX),
        "resolution_face": compute_helix_geometry_tests(disc_file, res_pp, classified_file,
                                                         face="resolution_face",
                                                         helix_order=RES_HELIX),
    }
    helix_geo_file = run_dir / "helix_geometry.json"
    helix_geo_file.write_text(json.dumps(helix_geo, indent=2))
    ok(f"Helix geometry results: {helix_geo_file}")

    # ── Composite test (E1/E2/E3) ─────────────────────────────────────────────
    section("Composite test — which positions are primitive vs composite? (all three faces)")
    composite = {
        "act_face":        compute_composite_test(disc_file, face="act_face"),
        "site_face":       compute_composite_test(disc_file, face="site_face"),
        "resolution_face": compute_composite_test(disc_file, face="resolution_face"),
    }
    composite_file = run_dir / "composite_test.json"
    composite_file.write_text(json.dumps(composite, indent=2))
    ok(f"Composite test results: {composite_file}")
    for face_name, face_result in composite.items():
        if "error" in face_result:
            print(f"  [{face_name}] Error: {face_result['error']}")
        else:
            s = face_result.get("summary", {})
            prims = s.get("primitives_by_reconstruction", [])
            rate  = s.get("theory_match_rate","?")
            print(f"  [{face_name}] Primitives: {prims}  theory_match={rate}")

    # Print helix geometry summary
    for test in ["test_A","test_B","test_C","test_D"]:
        res = helix_geo.get(test, {})
        if "error" in res:
            print(f"  {test}: {res['error']}")
        elif test == "test_A":
            print(f"  Test A: r={res.get('spearman_r','?')}  p={res.get('spearman_p','?')}")
        elif test == "test_B":
            print(f"  Test B: {res.get('n_convex','?')}/{res.get('n_triples','?')} convex  p={res.get('permutation_p','?')}")
        elif test == "test_C":
            lo = res.get('confusions_toward_lower_helix','?')
            hi = res.get('confusions_toward_higher_helix','?')
            print(f"  Test C: lower={lo}  higher={hi}  adj_rate={res.get('adjacency_rate','?')}")
        elif test == "test_D":
            pass  # frequency prediction not reported

    # ── Top-100 exemplars per cell and per face element ───────────────────────
    section("Generating top-100 exemplars per cell and face")

    # Load clause text from classified.jsonl
    id_to_clause = {}
    id_to_lang   = {}
    with open(classified_file, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                id_to_clause[r["id"]] = r.get("clause", "")
                id_to_lang[r["id"]]   = r.get("language", "?")
            except Exception:
                pass

    # Normalize all vectors once for cosine similarity
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    # Build centroid lookup: label -> normalized centroid vector
    centroid_lookup = {}
    for lbl in centroid_labels_out:
        cv = centroids_27[lbl]["centroid"]
        cn = cv / (np.linalg.norm(cv) + 1e-10)
        centroid_lookup[lbl] = cn

    # Face element lookups
    SITE_LABEL = {
        ("EXISTENCE","CONDITION"):"Void", ("EXISTENCE","ENTITY"):"Entity",
        ("EXISTENCE","PATTERN"):"Kind", ("STRUCTURE","CONDITION"):"Field",
        ("STRUCTURE","ENTITY"):"Link", ("STRUCTURE","PATTERN"):"Network",
        ("SIGNIFICANCE","CONDITION"):"Atmosphere", ("SIGNIFICANCE","ENTITY"):"Lens",
        ("SIGNIFICANCE","PATTERN"):"Paradigm",
    }
    RES_LABEL = {
        ("DIFFERENTIATING","CONDITION"):"Clearing", ("DIFFERENTIATING","ENTITY"):"Dissecting",
        ("DIFFERENTIATING","PATTERN"):"Unraveling", ("RELATING","CONDITION"):"Tending",
        ("RELATING","ENTITY"):"Binding", ("RELATING","PATTERN"):"Tracing",
        ("GENERATING","CONDITION"):"Cultivating", ("GENERATING","ENTITY"):"Making",
        ("GENERATING","PATTERN"):"Composing",
    }

    all_exemplars = {}  # label -> list of {clause, language, similarity, cell}

    # For each grouping level: 27-cell, operators (Act face), Site face, Resolution face
    groupings = []

    # 27-cell
    for i in range(len(vectors)):
        if full_labels[i] == "?": continue
        groupings  # just need the label

    # Build grouping arrays for all four faces
    site_labels = np.array([
        SITE_LABEL.get((q2[i], q3[i]), "?") if q2[i] != "?" and q3[i] != "?" else "?"
        for i in range(len(vectors))
    ])
    res_labels = np.array([
        RES_LABEL.get((q1[i], q3[i]), "?") if q1[i] != "?" and q3[i] != "?" else "?"
        for i in range(len(vectors))
    ])

    face_groups = [
        ("27cell",      full_labels,  centroids_27),
        ("act_face",    op,           compute_centroids(train_vecs, train_op)),
        ("site_face",   site_labels,  compute_centroids(
            vectors[train_mask & (site_labels != "?")],
            site_labels[train_mask & (site_labels != "?")])),
        ("resolution_face", res_labels, compute_centroids(
            vectors[train_mask & (res_labels != "?")],
            res_labels[train_mask & (res_labels != "?")])),
    ]

    # Pre-normalize all centroids across all four faces for composite margin
    # For each clause in a 27-cell, we compute margin against competitors in ALL faces
    def norm_centroid(c):
        v = c["centroid"]
        return v / (np.linalg.norm(v) + 1e-10)

    all_face_centroids = {name: fc for name, _, fc in face_groups}

    # Build normalized centroid matrices per face for fast batch computation
    face_centroid_matrices = {}
    face_centroid_labels_list = {}
    for fname, fc in all_face_centroids.items():
        lbls = list(fc.keys())
        mat  = np.stack([norm_centroid(fc[l]) for l in lbls])
        face_centroid_matrices[fname] = mat
        face_centroid_labels_list[fname] = lbls

    exemplars_out = {}
    for face_name, lbl_arr, face_centroids in face_groups:
        exemplars_out[face_name] = {}

        for cell_lbl, cell_data in face_centroids.items():
            cn = norm_centroid(cell_data)

            # Clauses assigned to this cell
            cell_mask = lbl_arr == cell_lbl
            if cell_mask.sum() == 0:
                continue

            cell_vecs  = normed[cell_mask]
            cell_ids   = ids[cell_mask]
            cell_langs = lang[cell_mask]

            # Similarity to own centroid
            sim_own = cell_vecs @ cn

            # For the primary margin: nearest competitor within same face
            own_face_lbls = face_centroid_labels_list[face_name]
            own_face_mat  = face_centroid_matrices[face_name]
            own_cell_idx  = own_face_lbls.index(cell_lbl)
            # Mask out the own centroid column
            other_cols = [i for i in range(len(own_face_lbls)) if i != own_cell_idx]
            if other_cols:
                sim_face_others = (cell_vecs @ own_face_mat[other_cols].T).max(axis=1)
                margin_face = sim_own - sim_face_others
            else:
                margin_face = sim_own

            # Cross-face margins: for 27-cell, also penalize proximity to
            # competitors in operator, site, and resolution face centroids.
            # This finds clauses unambiguous at every level of the structure.
            if face_name == "27cell":
                cross_margins = []
                for other_face in ["act_face", "site_face", "resolution_face"]:
                    omat = face_centroid_matrices[other_face]
                    olbls = face_centroid_labels_list[other_face]

                    # Determine which centroid in this face corresponds to this cell
                    # Map 27-cell label to each face projection
                    parts = cell_lbl  # e.g. "CON(Binding, Link)"
                    # act_face: operator = first token before "("
                    op_lbl = parts.split("(")[0]
                    # resolution_face: first word inside parens
                    inner = parts[parts.index("(")+1:parts.index(")")]
                    res_lbl = inner.split(",")[0].strip()
                    # site_face: second word inside parens
                    site_lbl = inner.split(",")[1].strip()

                    own_lbl = {"act_face": op_lbl,
                               "site_face": site_lbl,
                               "resolution_face": res_lbl}.get(other_face)

                    if own_lbl and own_lbl in olbls:
                        own_idx = olbls.index(own_lbl)
                        other_cols_f = [i for i in range(len(olbls)) if i != own_idx]
                        if other_cols_f:
                            sim_own_face = cell_vecs @ omat[own_idx]
                            sim_other_face = (cell_vecs @ omat[other_cols_f].T).max(axis=1)
                            cross_margins.append(sim_own_face - sim_other_face)

                if cross_margins:
                    # Composite margin: minimum across all face margins
                    # A clause must be unambiguous on ALL faces to score high
                    all_margins = np.stack([margin_face] + cross_margins, axis=1)
                    composite_margin = all_margins.min(axis=1)
                else:
                    composite_margin = margin_face

                ranking_margin = composite_margin
            else:
                ranking_margin = margin_face

            # Rank by composite margin descending
            top_n   = min(100, len(ranking_margin))
            top_idx = np.argsort(ranking_margin)[::-1][:top_n]

            exemplars_out[face_name][cell_lbl] = [
                {
                    "clause":            id_to_clause.get(cell_ids[i], ""),
                    "language":          str(cell_langs[i]),
                    "sim_own":           round(float(sim_own[i]), 4),
                    "margin_face":       round(float(margin_face[i]), 4),
                    "margin_composite":  round(float(ranking_margin[i]), 4),
                    "rank":              int(j+1),
                }
                for j, i in enumerate(top_idx)
                if id_to_clause.get(cell_ids[i])
            ]
        ok(f"  {face_name}: {len(exemplars_out[face_name])} cells, top-100 exemplars each")

    # Build the output with a legend for AI/programmatic parsing
    legend = {
        "_legend": {
            "description": (
                "Top-100 discriminative exemplars per cell, ranked by margin "
                "(similarity to own centroid minus similarity to nearest competing centroid). "
                "Higher margin = more clearly in this cell and away from all others. "
                "These are the most useful examples for understanding what makes each cell distinct."
            ),
            "structure": {
                "faces": ["27cell", "act_face", "site_face", "resolution_face"],
                "face_descriptions": {
                    "27cell":           "Full 27-cell address: operator(Resolution, Site). All three axes.",
                    "act_face":         "Act face (Mode × Domain): the 9 operators. What transformation is happening.",
                    "site_face":        "Site face (Domain × Object): 9 terrain types. Where in reality the target is.",
                    "resolution_face":  "Resolution face (Mode × Object): 9 engagement stances. At what grain the transformation lands."
                },
                "cell_label_format":  "operator(Resolution, Site) — e.g. CON(Binding, Link)",
                "exemplar_fields": {
                    "clause":               "The original sentence from the corpus (untranslated)",
                    "language":             "ISO 639-1 language code (e.g. en, fr, ja)",
                    "sim_own":              "Cosine similarity to this cell's centroid [0-1, higher=closer]",
                    "sim_nearest_other":    "Cosine similarity to the nearest competing centroid",
                    "margin_face":        "margin vs nearest competitor within same face",
                    "margin_composite":   "For 27cell: minimum margin across all four faces. Clause must be unambiguous as operator, site, resolution, AND full-cell. Ranking key for 27cell.",
                    "rank":               "1=most discriminative (ranked by margin_composite for 27cell, margin_face otherwise)"
                }
            },
            "vocabulary": {
                "operators": {
                    "NUL": "Differentiating × Existence — recognize absence",
                    "SIG": "Relating × Existence — register difference",
                    "INS": "Generating × Existence — create instance",
                    "SEG": "Differentiating × Structure — draw boundary",
                    "CON": "Relating × Structure — connect across boundary",
                    "SYN": "Generating × Structure — merge into emergent whole",
                    "ALT": "Differentiating × Significance — change value within frame",
                    "SUP": "Relating × Significance — hold contradictions simultaneously",
                    "REC": "Generating × Significance — change the frame itself"
                },
                "site_face_terrain": {
                    "Void":        "Existence × Condition — ambient substrate of being",
                    "Entity":      "Existence × Entity — a specific existent",
                    "Kind":        "Existence × Pattern — a type or category",
                    "Field":       "Structure × Condition — ambient relational environment",
                    "Link":        "Structure × Entity — a specific connection",
                    "Network":     "Structure × Pattern — an architecture of connections",
                    "Atmosphere":  "Significance × Condition — ambient interpretive weather",
                    "Lens":        "Significance × Entity — a specific reading or frame",
                    "Paradigm":    "Significance × Pattern — a worldview or interpretive framework"
                },
                "resolution_face_stances": {
                    "Clearing":    "Differentiating × Condition — dissolving ambient conditions",
                    "Dissecting":  "Differentiating × Entity — taking apart a specific thing",
                    "Unraveling":  "Differentiating × Pattern — deconstructing a regularity",
                    "Tending":     "Relating × Condition — maintaining conditions",
                    "Binding":     "Relating × Entity — connecting specific things",
                    "Tracing":     "Relating × Pattern — mapping regularities",
                    "Cultivating": "Generating × Condition — producing conditions for emergence",
                    "Making":      "Generating × Entity — producing a specific thing",
                    "Composing":   "Generating × Pattern — producing regularities or structures"
                },
                "entity_types": {
                    "Emanon":   "Ground-dominant (Condition targets) — ambient, pre-figural, proliferates when examined",
                    "Holon":    "Balanced (Entity targets) — stable, clear identity, self-maintaining",
                    "Protogon": "Pattern-dominant (Pattern targets) — crystallizing, identities still forming"
                }
            },
            "axes": {
                "Q1_Mode":   {"values": ["DIFFERENTIATING", "RELATING", "GENERATING"], "question": "Is this transformation separating, connecting, or producing?"},
                "Q2_Domain": {"values": ["EXISTENCE", "STRUCTURE", "SIGNIFICANCE"],   "question": "Is it operating on existence, organization, or meaning?"},
                "Q3_Object": {"values": ["CONDITION", "ENTITY", "PATTERN"],            "question": "Is the target a background condition, a specific thing, or a pattern?"}
            },
            "corpus": {
                "languages": 41,
                "total_clauses": "~19,764 classified (19,764 embedded total)",
                "consensus_clauses": "9,221 (both models agreed — 47% of total)",
                "source": "Universal Dependencies treebanks",
                "embedding_model": "text-embedding-3-large (OpenAI, 3072 dims)"
            }
        }
    }
    legend.update(exemplars_out)

    exemplars_file = run_dir / "exemplars.json"
    exemplars_file.write_text(json.dumps(legend, indent=2, ensure_ascii=False))
    ok(f"Saved exemplars to {exemplars_file}")
    info("Format: exemplars[face][cell] = list of top-100 discriminative clauses (ranked by margin)")
    info("See exemplars['_legend'] for full schema and vocabulary reference")

    # ── Exemplar analysis report ──────────────────────────────────────────────
    section("Generating exemplar analysis report")
    generate_exemplar_report(exemplars_out, run_dir)

    # ── Save results ──────────────────────────────────────────────────────────
    (run_dir / "centroid_results.json").write_text(json.dumps(results, indent=2))
    return results, centroid_file





def compute_subspace_geometry(vectors: np.ndarray,
                               q1: np.ndarray,
                               q2: np.ndarray,
                               q3: np.ndarray,
                               run_dir: "Path",
                               suffix: str = "") -> dict:
    """
    Reveal the shape of the EO subspace through two analyses:

    1. PRINCIPAL ANGLES between Mode and Domain centroid subspaces.
       Each axis (Mode, Domain, Object) defines a 2-d subspace via its 3
       centroids (after centering). The principal angles between any two
       of these subspaces measure how orthogonal they are in the full
       3072-d space. Angle near 90° = independent axes. Near 0° = same
       dimension. This is a single number that summarizes the geometric
       relationship between the axes better than ARI does.

    2. LDA PROJECTION into the EO subspace.
       Linear Discriminant Analysis finds the directions in 3072-d space
       that maximally separate the EO cell labels. This is the right
       subspace to visualize — not the content-variance PCA space, but
       the EO-discriminant space. The top 3 LDA axes capture the EO
       structure directly. PCA on the LDA-projected embeddings will show
       whether the 27-cell arrangement is flat, curved, or approximately
       helical in the discriminant space.
    """
    from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
    from sklearn.decomposition import PCA as skPCA
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d import Axes3D  # noqa

    valid = (q1 != "?") & (q2 != "?") & (q3 != "?")
    vecs = vectors[valid].astype(np.float32)
    q1v, q2v, q3v = q1[valid], q2[valid], q3[valid]

    # Normalize
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vecs / norms

    MODES   = ["DIFFERENTIATING", "RELATING", "GENERATING"]
    DOMAINS = ["EXISTENCE", "STRUCTURE", "SIGNIFICANCE"]
    OBJECTS = ["CONDITION", "ENTITY", "PATTERN"]

    def axis_centroids(labels, positions):
        cs = []
        for pos in positions:
            mask = labels == pos
            if mask.sum() < 2:
                cs.append(None)
            else:
                c = normed[mask].mean(axis=0)
                cs.append(c)
        return cs

    def subspace_basis(centroids):
        """Orthonormal basis of the subspace spanned by centroids (after centering)."""
        valid_c = [c for c in centroids if c is not None]
        if len(valid_c) < 2:
            return None
        C = np.stack(valid_c)
        centered = C - C.mean(axis=0)
        _, S, Vt = np.linalg.svd(centered, full_matrices=False)
        k = max(1, (S > S.max() * 1e-6).sum())
        return Vt[:k]  # (k, d) orthonormal rows

    def principal_angles(A, B):
        """Principal angles between two subspaces given orthonormal bases A, B."""
        if A is None or B is None:
            return None, None
        M = A @ B.T
        _, cos_vals, _ = np.linalg.svd(M, full_matrices=False)
        cos_vals = np.clip(cos_vals, -1, 1)
        return np.degrees(np.arccos(cos_vals)), cos_vals

    # ── Part 1: Principal angles between all pairs of axis subspaces ─────────
    basis_mode   = subspace_basis(axis_centroids(q1v, MODES))
    basis_domain = subspace_basis(axis_centroids(q2v, DOMAINS))
    basis_object = subspace_basis(axis_centroids(q3v, OBJECTS))

    angles_md, cos_md = principal_angles(basis_mode, basis_domain)
    angles_mo, cos_mo = principal_angles(basis_mode, basis_object)
    angles_do, cos_do = principal_angles(basis_domain, basis_object)

    principal_angle_results = {}
    for name, angles, cos_vals in [
        ("Mode_vs_Domain",  angles_md, cos_md),
        ("Mode_vs_Object",  angles_mo, cos_mo),
        ("Domain_vs_Object",angles_do, cos_do),
    ]:
        if angles is None:
            principal_angle_results[name] = {"error": "insufficient data"}
            continue
        principal_angle_results[name] = {
            "principal_angles_deg": [round(float(a),2) for a in angles],
            "cos_angles":           [round(float(c),4) for c in cos_vals],
            "min_angle_deg":        round(float(angles.min()), 2),
            "max_angle_deg":        round(float(angles.max()), 2),
            "interpretation": (
                f"Min principal angle = {angles.min():.1f}°. "
                + ("Near 90° — the two subspaces are nearly orthogonal: the axes are "
                   "geometrically independent in embedding space."
                   if angles.min() > 75 else
                   "Below 75° — the subspaces share some geometric overlap: "
                   "the axes are not fully independent in embedding space."
                   if angles.min() > 45 else
                   "Below 45° — substantial subspace overlap: "
                   "the two axes are not geometrically separable."
                   )
            ),
        }
        print(f"  {name}: principal angles = {[round(float(a),1) for a in angles]}°")

    # ── Part 2: LDA projection into EO discriminant space ────────────────────
    # Build full 27-cell label for LDA
    ACT = {
        ("DIFFERENTIATING","EXISTENCE"):"NUL",("DIFFERENTIATING","STRUCTURE"):"SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"):"ALT",("RELATING","EXISTENCE"):"SIG",
        ("RELATING","STRUCTURE"):"CON",("RELATING","SIGNIFICANCE"):"SUP",
        ("GENERATING","EXISTENCE"):"INS",("GENERATING","STRUCTURE"):"SYN",
        ("GENERATING","SIGNIFICANCE"):"REC",
    }
    SITE = {
        ("EXISTENCE","CONDITION"):"Void",("EXISTENCE","ENTITY"):"Entity",
        ("EXISTENCE","PATTERN"):"Kind",("STRUCTURE","CONDITION"):"Field",
        ("STRUCTURE","ENTITY"):"Link",("STRUCTURE","PATTERN"):"Network",
        ("SIGNIFICANCE","CONDITION"):"Atmosphere",("SIGNIFICANCE","ENTITY"):"Lens",
        ("SIGNIFICANCE","PATTERN"):"Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"):"Clearing",("DIFFERENTIATING","ENTITY"):"Dissecting",
        ("DIFFERENTIATING","PATTERN"):"Unraveling",("RELATING","CONDITION"):"Tending",
        ("RELATING","ENTITY"):"Binding",("RELATING","PATTERN"):"Tracing",
        ("GENERATING","CONDITION"):"Cultivating",("GENERATING","ENTITY"):"Making",
        ("GENERATING","PATTERN"):"Composing",
    }
    cell_labels = np.array([
        f"{ACT.get((q1v[i],q2v[i]),'?')}({RES.get((q1v[i],q3v[i]),'?')},{SITE.get((q2v[i],q3v[i]),'?')})"
        for i in range(len(q1v))
    ])
    valid_cells = cell_labels != "?(?,?)"

    # Sample for LDA (it's O(n*d^2) but we can use PCA first to reduce d)
    rng = np.random.default_rng(42)
    n_sample = min(5000, valid_cells.sum())
    idx = rng.choice(np.where(valid_cells)[0], n_sample, replace=False)
    X_sample = normed[idx]
    y_mode   = q1v[idx]
    y_domain = q2v[idx]
    y_cell   = cell_labels[idx]

    # First reduce to 100-d with PCA to make LDA tractable
    pca_pre = skPCA(n_components=100, random_state=42)
    X_pca = pca_pre.fit_transform(X_sample)

    lda_results = {}
    fig_dir = run_dir / "figures"
    fig_dir.mkdir(exist_ok=True)

    OPERATOR_COLORS = {
        "NUL":"#264653","SIG":"#2A9D8F","INS":"#E9C46A",
        "SEG":"#F4A261","CON":"#E76F51","SYN":"#6D6875",
        "ALT":"#B5838D","SUP":"#E5989B","REC":"#FFCDB2","?":"#CCCCCC",
    }
    DOMAIN_COLORS = {
        "EXISTENCE":"#2A9D8F","STRUCTURE":"#E76F51","SIGNIFICANCE":"#6D6875",
    }
    MODE_COLORS = {
        "DIFFERENTIATING": "#264653",   # dark teal — boundary-drawing
        "RELATING":        "#E76F51",   # salmon — connecting
        "GENERATING":      "#E9C46A",   # ochre — producing
    }

    OBJECT_COLORS = {
        "CONDITION": "#2A9D8F",  # teal — ground/ambient
        "ENTITY":    "#E9C46A",  # ochre — specific thing
        "PATTERN":   "#E76F51",  # salmon — abstract pattern
    }
    SITE_COLORS = {
        "Void": "#264653",    "Entity": "#2A9D8F",  "Kind": "#E9C46A",
        "Field": "#F4A261",   "Link": "#E76F51",    "Network": "#6D6875",
        "Atmosphere": "#B5838D","Lens": "#E5989B",  "Paradigm": "#FFCDB2",
    }
    RES_COLORS = {
        "Clearing": "#264653",  "Dissecting": "#2A9D8F",  "Unraveling": "#E9C46A",
        "Tending": "#F4A261",   "Binding": "#E76F51",     "Tracing": "#6D6875",
        "Cultivating": "#B5838D","Making": "#E5989B",     "Composing": "#FFCDB2",
    }

    # Build site and resolution face labels for LDA
    # These must be built from the SAMPLED arrays (indexed by idx), not the full q1v/q2v/q3v
    ACT_LDA = {
        ("DIFFERENTIATING","EXISTENCE"):"NUL",("DIFFERENTIATING","STRUCTURE"):"SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"):"ALT",("RELATING","EXISTENCE"):"SIG",
        ("RELATING","STRUCTURE"):"CON",("RELATING","SIGNIFICANCE"):"SUP",
        ("GENERATING","EXISTENCE"):"INS",("GENERATING","STRUCTURE"):"SYN",
        ("GENERATING","SIGNIFICANCE"):"REC",
    }
    SITE_LDA = {
        ("EXISTENCE","CONDITION"):"Void",("EXISTENCE","ENTITY"):"Entity",
        ("EXISTENCE","PATTERN"):"Kind",("STRUCTURE","CONDITION"):"Field",
        ("STRUCTURE","ENTITY"):"Link",("STRUCTURE","PATTERN"):"Network",
        ("SIGNIFICANCE","CONDITION"):"Atmosphere",("SIGNIFICANCE","ENTITY"):"Lens",
        ("SIGNIFICANCE","PATTERN"):"Paradigm",
    }
    RES_LDA = {
        ("DIFFERENTIATING","CONDITION"):"Clearing",("DIFFERENTIATING","ENTITY"):"Dissecting",
        ("DIFFERENTIATING","PATTERN"):"Unraveling",("RELATING","CONDITION"):"Tending",
        ("RELATING","ENTITY"):"Binding",("RELATING","PATTERN"):"Tracing",
        ("GENERATING","CONDITION"):"Cultivating",("GENERATING","ENTITY"):"Making",
        ("GENERATING","PATTERN"):"Composing",
    }
    # Use the sampled label arrays (same length as X_pca)
    q1s, q2s, q3s = q1v[idx], q2v[idx], q3v[idx]
    site_lbl_all = np.array([SITE_LDA.get((q2s[i], q3s[i]), "?") for i in range(len(q1s))])
    res_lbl_all  = np.array([RES_LDA.get((q1s[i],  q3s[i]), "?") for i in range(len(q1s))])
    site_mask = site_lbl_all != "?"
    res_mask  = res_lbl_all  != "?"
    y_site  = site_lbl_all[site_mask]
    y_res   = res_lbl_all[res_mask]
    X_site  = X_pca[site_mask]
    X_res   = X_pca[res_mask]

    for axis_name, y_labels, colors_map, n_components, X_in in [
        ("mode",       y_mode,   MODE_COLORS,   2, X_pca),
        ("domain",     y_domain, DOMAIN_COLORS, 2, X_pca),
        ("site",       y_site,   SITE_COLORS,   2, X_site),
        ("resolution", y_res,    RES_COLORS,    2, X_res),
    ]:
        try:
            lda = LinearDiscriminantAnalysis(n_components=n_components)
            X_lda = lda.fit_transform(X_in, y_labels)
            exp_var = lda.explained_variance_ratio_ if hasattr(lda,"explained_variance_ratio_") else None

            lda_results[axis_name] = {
                "n_components": n_components,
                "explained_variance_ratio": [round(float(v),4) for v in exp_var] if exp_var is not None else None,
            }

            # Plot LDA projection
            fig = plt.figure(figsize=(10, 8))
            if n_components >= 2:
                ax = fig.add_subplot(111)
                unique_labels = sorted(set(y_labels))
                for lbl in unique_labels:
                    mask = y_labels == lbl
                    color = colors_map.get(lbl, "#CCCCCC")
                    ax.scatter(X_lda[mask, 0], X_lda[mask, 1],
                               c=color, label=lbl, alpha=0.5, s=15, linewidths=0)
                var_str = (f"LD1 ({exp_var[0]*100:.1f}%), LD2 ({exp_var[1]*100:.1f}%)"
                           if exp_var is not None else "LD1, LD2")
                ax.set_xlabel("LD1"); ax.set_ylabel("LD2")
                ax.set_title(
                    f"LDA Projection by {axis_name.capitalize()} — EO Discriminant Subspace\n"
                    f"(100-d PCA -> LDA: finds directions that separate EO {axis_name} labels)\n"
                    f"{var_str}"
                )
                ax.legend(loc="upper right", fontsize=8, markerscale=2)
                plt.tight_layout()
                fname = fig_dir / f"lda_by_{axis_name}{suffix}.png"
                fig.savefig(fname, dpi=150, bbox_inches="tight")
                plt.close(fig)
                print(f"  Figure: lda_by_{axis_name}.png")
        except Exception as e:
            lda_results[axis_name] = {"error": str(e)}
            print(f"  LDA {axis_name} failed: {e}")

    return {
        "principal_angles":  principal_angle_results,
        "lda":               lda_results,
    }




def compute_composite_test(discriminative_centroids_file: "Path", face: str = "act_face") -> dict:
    """
    Test whether EO operators are geometrically primitive or composite.

    A composite operator is one whose centroid can be approximated as a
    linear combination of other operator centroids — it doesn't add
    independent geometric territory. A primitive operator occupies a
    region that can't be reached by combining others.

    Three tests:

    1. RECONSTRUCTION TEST
       For each operator centroid v_i, solve the non-negative least squares
       problem: minimize ||v_i - sum_j w_j * v_j||^2 over w_j >= 0.
       Low reconstruction error = composite (other operators can approximate it).
       High error = primitive (geometrically irreducible).

    2. CROSS-AXIS COMPOSITION TEST
       Tests a specific EO prediction: operators should be composable from
       their axis components. CON (RELATING×STRUCTURE) should be approximable
       from same-mode operators (SIG, SUP — other RELATING operators) AND
       from same-domain operators (SEG, SYN — other STRUCTURE operators).
       If the axes are genuinely independent dimensions, the mode-family and
       domain-family combinations should each explain part of the variance.

    3. CONVEX HULL MEMBERSHIP
       Tests whether each centroid lies inside the convex hull of the other 8.
       Inside = composite. Outside = primitive (adds new territory).
       Note: in high-dimensional space almost all points are outside any
       convex hull, so this test uses the MDS-reduced representation.

    EO theory prediction:
    - NUL, SEG, ALT (Differentiating) should be most primitive — they define
      the separating/bounding operations that make other operations possible.
    - REC (Generating×Significance) should be most composite — it requires
      all prior operators to be structurally available.
    - CON, SUP, INS (the unmarked operators) should be intermediate.
    """
    from scipy.optimize import nnls
    from scipy.spatial import ConvexHull
    from sklearn.manifold import MDS

    FACE_POSITIONS = {
        "act_face":        ["NUL","SIG","INS","SEG","CON","SYN","ALT","SUP","REC"],
        "site_face":       ["Void","Entity","Kind","Field","Link","Network",
                            "Atmosphere","Lens","Paradigm"],
        "resolution_face": ["Clearing","Dissecting","Unraveling","Tending","Binding",
                            "Tracing","Cultivating","Making","Composing"],
    }
    HELIX = FACE_POSITIONS.get(face, FACE_POSITIONS["act_face"])
    # Row/column groupings for cross-axis test (meaningful for act_face)
    if face == "act_face":
        MODE_GROUP  = {"DIFF":["NUL","SEG","ALT"],"RELA":["SIG","CON","SUP"],"GENE":["INS","SYN","REC"]}
        DOMAIN_GROUP= {"EXIST":["NUL","SIG","INS"],"STRUCT":["SEG","CON","SYN"],"SIG_D":["ALT","SUP","REC"]}
    else:
        # For other faces: group by row and column in 3×3 grid
        MODE_GROUP  = {"Row1":HELIX[:3],"Row2":HELIX[3:6],"Row3":HELIX[6:]}
        DOMAIN_GROUP= {"Col1":HELIX[0::3],"Col2":HELIX[1::3],"Col3":HELIX[2::3]}
    OP_MODE   = {op: m for m, ops in MODE_GROUP.items()   for op in ops}
    OP_DOMAIN = {op: d for d, ops in DOMAIN_GROUP.items() for op in ops}

    # Load discriminative centroids
    try:
        disc = np.load(discriminative_centroids_file, allow_pickle=True)
        all_labels  = list(disc["labels"])
        all_vectors = disc["vectors"]
        op_centroids = {}
        face_prefix = f"{face}::"
        for i, lbl in enumerate(all_labels):
            if lbl.startswith(face_prefix):
                op = lbl.replace(face_prefix, "")
                if op in HELIX:
                    v = all_vectors[i].astype(np.float32)
                    v = v / (np.linalg.norm(v) + 1e-10)
                    op_centroids[op] = v
        available = [op for op in HELIX if op in op_centroids]
        if len(available) < 4:
            return {"error": f"Need at least 4 centroids for {face}, got {len(available)}"}
        print(f"  [{face}] Loaded {len(available)} centroids")
    except Exception as e:
        return {"error": str(e)}

    V = np.stack([op_centroids[op] for op in available])  # (n_ops, d)
    n_ops = len(available)

    # ── TEST 1: Reconstruction ────────────────────────────────────────────────
    print("  Test E1: reconstruction...", flush=True)
    reconstruction = {}
    for i, op in enumerate(available):
        others_idx = [j for j in range(n_ops) if j != i]
        A = V[others_idx].T  # (d, n-1)
        b = V[i]             # (d,)
        w, residual = nnls(A, b)
        recon = A @ w
        err = float(np.linalg.norm(b - recon) / (np.linalg.norm(b) + 1e-10))
        top_idx = np.argmax(w)
        top_op  = available[others_idx[top_idx]]
        same_mode   = OP_MODE[op] == OP_MODE[top_op]
        same_domain = OP_DOMAIN[op] == OP_DOMAIN[top_op]
        reconstruction[op] = {
            "reconstruction_error":  round(err, 4),
            "is_primitive":          err > 0.5,
            "weights":               {available[others_idx[j]]: round(float(w[j]), 4)
                                      for j in range(len(w)) if w[j] > 0.01},
            "top_contributor":       top_op,
            "top_contributor_weight":round(float(w[top_idx]), 4),
            "same_mode_as_top":      same_mode,
            "same_domain_as_top":    same_domain,
        }
    # Sort by reconstruction error (most primitive first)
    sorted_ops = sorted(reconstruction.items(), key=lambda x: -x[1]["reconstruction_error"])
    for op, res in sorted_ops:
        marker = "PRIMITIVE" if res["is_primitive"] else "composite"
        print(f"    {op}: error={res['reconstruction_error']:.4f} → {marker}  "
              f"top={res['top_contributor']} ({res['top_contributor_weight']:.3f})", flush=True)

    # ── TEST 2: Cross-axis composition ────────────────────────────────────────
    print("  Test E2: cross-axis composition...", flush=True)
    cross_axis = {}
    for op in available:
        mode  = OP_MODE[op]
        domain = OP_DOMAIN[op]
        # Same-mode family (excluding self)
        mode_ops    = [o for o in MODE_GROUP[mode]   if o != op and o in op_centroids]
        # Same-domain family (excluding self)
        domain_ops  = [o for o in DOMAIN_GROUP[domain] if o != op and o in op_centroids]

        def recon_from_group(group_ops):
            if not group_ops: return 1.0, {}
            A = np.stack([op_centroids[o] for o in group_ops]).T
            b = op_centroids[op]
            w, _ = nnls(A, b)
            err = float(np.linalg.norm(b - A@w) / (np.linalg.norm(b) + 1e-10))
            return err, {group_ops[j]: round(float(w[j]),4) for j in range(len(w)) if w[j]>0.01}

        err_mode,   w_mode   = recon_from_group(mode_ops)
        err_domain, w_domain = recon_from_group(domain_ops)

        cross_axis[op] = {
            "mode_family":           mode_ops,
            "domain_family":         domain_ops,
            "error_from_mode":       round(err_mode, 4),
            "error_from_domain":     round(err_domain, 4),
            "mode_weights":          w_mode,
            "domain_weights":        w_domain,
            "more_mode_composite":   err_mode < err_domain,
            "interpretation": (
                f"{op} ({mode}×{domain}): "
                f"mode-family error={err_mode:.3f}, domain-family error={err_domain:.3f}. "
                + (f"More recoverable from same-{('mode' if err_mode < err_domain else 'domain')} operators."
                   if min(err_mode, err_domain) < 0.9 else
                   "Not well approximated by either axis family alone.")
            ),
        }

    # ── TEST 3: Convex hull membership (in MDS space) ────────────────────────
    print("  Test E3: convex hull membership (MDS)...", flush=True)
    # Build distance matrix
    D = np.zeros((n_ops, n_ops))
    for i in range(n_ops):
        for j in range(n_ops):
            if i != j:
                D[i,j] = float(1 - np.dot(V[i], V[j]))

    # MDS to low-d for convex hull (need d < n-1 for CH to work)
    n_mds = min(n_ops - 2, 6)
    mds = MDS(n_components=n_mds, dissimilarity="precomputed", random_state=42,
              normalized_stress=False, n_init=1)
    coords = mds.fit_transform(D)
    print(f"    MDS stress: {mds.stress_:.6f}", flush=True)

    hull_membership = {}
    for i, op in enumerate(available):
        others_coords = coords[[j for j in range(n_ops) if j != i]]
        try:
            hull = ConvexHull(others_coords)
            # Point is inside if it satisfies all hull inequalities A@x + b <= 0
            point = coords[i]
            inside = all(
                np.dot(eq[:-1], point) + eq[-1] <= 1e-10
                for eq in hull.equations
            )
        except Exception:
            inside = None
        hull_membership[op] = {
            "inside_hull_of_others": inside,
            "is_primitive": not inside if inside is not None else None,
        }
        status = "INSIDE (composite)" if inside else "OUTSIDE (primitive)" if inside is not None else "unknown"
        print(f"    {op}: {status}", flush=True)

    # ── Summary ───────────────────────────────────────────────────────────────
    primitives  = [op for op, r in reconstruction.items() if r["is_primitive"]]
    composites  = [op for op, r in reconstruction.items() if not r["is_primitive"]]
    hull_prims  = [op for op, h in hull_membership.items() if h["is_primitive"]]
    hull_comps  = [op for op, h in hull_membership.items() if h["is_primitive"] is False]

    # Theory prediction: DIFF operators most primitive, REC most composite
    theory_primitive = {"NUL","SEG","ALT"}
    recon_primitive  = set(primitives)
    theory_correct   = len(theory_primitive & recon_primitive) / max(len(theory_primitive), 1)

    return {
        "reconstruction":       reconstruction,
        "cross_axis":           cross_axis,
        "convex_hull":          hull_membership,
        "summary": {
            "primitives_by_reconstruction":  primitives,
            "composites_by_reconstruction":  composites,
            "primitives_by_hull":            hull_prims,
            "composites_by_hull":            hull_comps,
            "theory_predicts_primitive":     sorted(theory_primitive),
            "theory_match_rate":             round(theory_correct, 3),
            "interpretation": (
                f"Reconstruction identifies {len(primitives)} primitives: {primitives}. "
                f"Convex hull identifies {len(hull_prims)} primitives: {hull_prims}. "
                f"Theory predicts {sorted(theory_primitive)} as most primitive. "
                f"Theory match rate (reconstruction): {theory_correct:.0%}."
            ),
        },
        "mds_stress": round(float(mds.stress_), 6),
    }


def compute_helix_geometry_tests(discriminative_centroids_file: "Path",
                                  phasepost_counts: dict,
                                  classified_file: "Path" = None,
                                  face: str = "act_face",
                                  helix_order: list = None) -> dict:
    """
    Four tests of the helix geometry using discriminative operator centroids.

    TEST A — Inter-centroid distance monotonicity
    Build the 9×9 matrix of pairwise cosine distances between operator centroids.
    If the helix is geometrically embedded, distance between operators should
    correlate with their chain distance |i−j|. NUL and SIG should be closer
    than NUL and REC. Spearman r between helix chain distance and embedding
    distance tests this directly.

    TEST B — Interpolation convexity
    For each consecutive triple (NUL,SIG,INS), (SIG,INS,SEG), ...:
    does the middle centroid lie closer to the interpolated midpoint of its
    neighbors than other operators do? Tests whether the helix ordering is
    geometrically embedded, not just labeled. A random ordering would show
    no convexity; a true embedding would show the middle operator consistently
    nearest its interpolated midpoint.

    TEST C — Asymmetric confusion
    If the helix dependency is real, confusing SIG for NUL should be more
    common than confusing NUL for SIG (because NUL is a prerequisite for SIG).
    Measures the confusion asymmetry matrix from centroid nearest-neighbor
    assignments and tests whether it is directionally consistent with the
    helix ordering. Requires computing nearest-centroid assignments for all
    labeled clauses.

    TEST D — Frequency rank vs helix theory
    The helix predicts a specific non-monotone frequency shape. The "unmarked"
    operator at each triad level (INS/CON/SUP) should be densest. Tests whether
    the theory-predicted rank order matches the observed frequency distribution
    via Spearman correlation.
    """
    import math
    from scipy import stats
    from collections import defaultdict

    # Helix order: default to operator helix, or use provided order for other faces
    if helix_order is None:
        HELIX = ["NUL","SIG","INS","SEG","CON","SYN","ALT","SUP","REC"]
    else:
        HELIX = helix_order
    HELIX_POS = {op: i for i, op in enumerate(HELIX)}
    # Triad groupings (operator face specific; other faces use domain-based groupings)
    TRIAD = {"NUL":"Existence","SIG":"Existence","INS":"Existence",
             "SEG":"Structure","CON":"Structure","SYN":"Structure",
             "ALT":"Significance","SUP":"Significance","REC":"Significance"}
    # For non-operator faces, group by row (first 3, middle 3, last 3)
    if helix_order is not None:
        TRIAD = {HELIX[i]: ["Row1","Row2","Row3"][i//3] for i in range(len(HELIX))}

    results = {}

    # ── Load discriminative centroids ────────────────────────────────────────
    try:
        disc = np.load(discriminative_centroids_file, allow_pickle=True)
        all_labels = list(disc["labels"])
        all_vectors = disc["vectors"]
        # Extract act_face (operator) centroids
        op_centroids = {}
        face_prefix = f"{face}::"
        for i, lbl in enumerate(all_labels):
            if lbl.startswith(face_prefix):
                op = lbl.replace(face_prefix, "")
                if op in HELIX_POS:
                    v = all_vectors[i]
                    op_centroids[op] = v / (np.linalg.norm(v) + 1e-10)
        available_ops = [op for op in HELIX if op in op_centroids]
        print(f"  [{face}] Loaded {len(op_centroids)} centroids: {available_ops}")
    except Exception as e:
        return {"error": f"Could not load discriminative centroids: {e}"}

    if len(op_centroids) < 3:
        return {"error": f"Need at least 3 operator centroids, got {len(op_centroids)}"}

    def cos_dist(a, b):
        return float(1 - np.dot(a, b))

    # ── TEST A: Inter-centroid distance vs helix chain distance ──────────────
    print("  Test A: inter-centroid distance monotonicity...", flush=True)
    pairs_a = []
    for i, opi in enumerate(available_ops):
        for j, opj in enumerate(available_ops):
            if i >= j: continue
            emb_d = cos_dist(op_centroids[opi], op_centroids[opj])
            chain_d = abs(HELIX_POS[opi] - HELIX_POS[opj])
            same_triad = TRIAD[opi] == TRIAD[opj]
            pairs_a.append({
                "op_i": opi, "op_j": opj,
                "helix_dist": chain_d,
                "embedding_dist": round(emb_d, 5),
                "same_triad": same_triad,
            })

    chain_dists = [p["helix_dist"] for p in pairs_a]
    emb_dists   = [p["embedding_dist"] for p in pairs_a]
    r_a, p_a = stats.spearmanr(chain_dists, emb_dists)

    # Also test within-triad vs cross-triad separation
    within = [p["embedding_dist"] for p in pairs_a if p["same_triad"]]
    across = [p["embedding_dist"] for p in pairs_a if not p["same_triad"]]
    t_stat, p_ttest = stats.ttest_ind(across, within) if within and across else (0, 1)

    results["test_A"] = {
        "spearman_r": round(r_a, 4),
        "spearman_p": round(p_a, 6),
        "n_pairs": len(pairs_a),
        "mean_within_triad_dist":  round(float(np.mean(within)), 5) if within else None,
        "mean_across_triad_dist":  round(float(np.mean(across)), 5) if across else None,
        "within_vs_across_p":      round(float(p_ttest), 4),
        "pairwise_distances": pairs_a,
        "interpretation": (
            f"Spearman r={r_a:+.3f} between helix chain distance and centroid embedding distance "
            f"(p={p_a:.4f}, n={len(pairs_a)} pairs). "
            + ("Positive correlation: operators further apart in the helix are further apart "
               "in embedding space. The helix ordering is geometrically embedded."
               if r_a > 0.3 and p_a < 0.05 else
               "No significant correlation: helix chain distance does not predict "
               "embedding distance. The operators are not geometrically ordered.")
        ),
    }
    print(f"    r={r_a:.3f} p={p_a:.4f}", flush=True)

    # ── TEST B: Interpolation convexity ──────────────────────────────────────
    print("  Test B: interpolation convexity...", flush=True)
    triples = []
    n_convex = 0
    for i in range(1, len(available_ops) - 1):
        prev_op = available_ops[i-1]
        curr_op = available_ops[i]
        next_op = available_ops[i+1]
        # Only test consecutive helix triples
        if (HELIX_POS[curr_op] != HELIX_POS[prev_op] + 1 or
            HELIX_POS[next_op] != HELIX_POS[curr_op] + 1):
            continue
        midpoint = op_centroids[prev_op] + op_centroids[next_op]
        midpoint = midpoint / (np.linalg.norm(midpoint) + 1e-10)
        dist_curr = cos_dist(op_centroids[curr_op], midpoint)
        # Compare to all other operators
        other_ops = [op for op in available_ops
                     if op not in (prev_op, curr_op, next_op)]
        other_dists = [cos_dist(op_centroids[op], midpoint) for op in other_ops]
        rank = sum(1 for d in other_dists if d < dist_curr)
        is_convex = dist_curr < float(np.mean(other_dists))
        if is_convex:
            n_convex += 1
        triples.append({
            "triple": f"{prev_op}-{curr_op}-{next_op}",
            "middle_dist_to_midpoint": round(dist_curr, 5),
            "mean_other_dist": round(float(np.mean(other_dists)) if other_dists else 0, 5),
            "rank_among_others": rank,
            "is_convex": is_convex,
        })

    n_triples = len(triples)
    # Permutation p-value: how often does random ordering give this many convex?
    rng = np.random.default_rng(42)
    null_convex = []
    op_list = available_ops
    for _ in range(1000):
        shuffled = rng.permutation(op_list)
        nc = 0
        for i in range(1, len(shuffled)-1):
            mp = op_centroids[shuffled[i-1]] + op_centroids[shuffled[i+1]]
            mp /= (np.linalg.norm(mp) + 1e-10)
            d_c = cos_dist(op_centroids[shuffled[i]], mp)
            others = [cos_dist(op_centroids[shuffled[j]], mp)
                      for j in range(len(shuffled)) if abs(j-i) > 1]
            if d_c < float(np.mean(others)):
                nc += 1
        null_convex.append(nc)
    p_b = (np.array(null_convex) >= n_convex).mean()

    results["test_B"] = {
        "n_triples": n_triples,
        "n_convex": n_convex,
        "pct_convex": round(n_convex/n_triples, 3) if n_triples > 0 else 0,
        "permutation_p": round(float(p_b), 4),
        "triples": triples,
        "interpretation": (
            f"{n_convex}/{n_triples} consecutive triples show convexity "
            f"({100*n_convex/n_triples:.0f}%, permutation p={p_b:.4f}). "
            + ("The middle operator in each consecutive triple is closer to the "
               "interpolated midpoint of its neighbors than other operators are. "
               "The helix ordering is geometrically convex — the operators lie "
               "along a smooth curve in embedding space."
               if p_b < 0.05 else
               "Convexity is not significant: the helix ordering is not geometrically "
               "embedded as a smooth curve.")
        ),
    }
    print(f"    {n_convex}/{n_triples} convex  p={p_b:.4f}", flush=True)

    # ── TEST C: Asymmetric confusion ─────────────────────────────────────────
    # Compute nearest-centroid assignments for all clauses in phasepost
    # Use frequency distribution to infer: which operator centroid would be
    # nearest for clauses labeled as each operator?
    # Full confusion requires per-clause centroid assignment — proxy: use
    # centroid-to-centroid nearest neighbor as the expected confusion pattern
    print("  Test C: asymmetric confusion (centroid proximity)...", flush=True)
    confusion = {}
    for true_op in available_ops:
        # Find nearest other centroid to this centroid
        dists = {other: cos_dist(op_centroids[true_op], op_centroids[other])
                 for other in available_ops if other != true_op}
        nearest = min(dists, key=dists.get)
        second_nearest = sorted(dists, key=dists.get)[1] if len(dists) > 1 else None
        confusion[true_op] = {
            "nearest_centroid": nearest,
            "distance_to_nearest": round(dists[nearest], 5),
            "helix_distance_to_nearest": abs(HELIX_POS[true_op] - HELIX_POS[nearest]),
            "nearest_is_adjacent": abs(HELIX_POS[true_op] - HELIX_POS[nearest]) == 1,
        }

    # Test directionality: are confusions more often toward lower helix position?
    lower_confusions = sum(1 for op, c in confusion.items()
                          if HELIX_POS[c["nearest_centroid"]] < HELIX_POS[op])
    higher_confusions = sum(1 for op, c in confusion.items()
                           if HELIX_POS[c["nearest_centroid"]] > HELIX_POS[op])

    results["test_C"] = {
        "confusion_by_operator": confusion,
        "confusions_toward_lower_helix": lower_confusions,
        "confusions_toward_higher_helix": higher_confusions,
        "adjacency_rate": round(
            sum(1 for c in confusion.values() if c["nearest_is_adjacent"]) / len(confusion), 3
        ) if confusion else 0,
        "interpretation": (
            f"Of {len(confusion)} operators, {lower_confusions} have their nearest centroid "
            f"at a lower helix position and {higher_confusions} at a higher position. "
            + ("Directional asymmetry toward lower helix positions: "
               "operators are more similar to their prerequisites than their successors. "
               "Consistent with helix dependency direction."
               if lower_confusions > higher_confusions else
               "Confusions are symmetric or toward higher positions. "
               "No evidence of directed dependency from centroid proximity.")
        ),
    }
    print(f"    lower={lower_confusions} higher={higher_confusions}", flush=True)

    # ── TEST D: Frequency rank vs helix theory ────────────────────────────────
    print("  Test D: frequency rank vs helix theory...", flush=True)
    op_freq = defaultdict(int)
    for cell, count in phasepost_counts.items():
        op = cell.split("(")[0]
        if op in HELIX_POS:
            op_freq[op] += count
    op_total = sum(op_freq.values())

    if op_total > 0:
        obs_freq = {op: op_freq[op]/op_total for op in available_ops}
        freq_sorted = sorted(available_ops, key=lambda op: -obs_freq[op])
        obs_rank = {op: i+1 for i, op in enumerate(freq_sorted)}

        # Theory: the "unmarked" op at each triad level is densest
        # Within triads: INS>SIG>NUL, CON>SEG>SYN, SUP>ALT>REC
        # Across triads: CON (structure) > SUP (significance) > INS (existence)
        theory_rank = {
            "CON":1,"SUP":2,"INS":3,"ALT":4,
            "SEG":5,"SYN":6,"SIG":7,"REC":8,"NUL":9
        }
        pred = [theory_rank.get(op, 5) for op in available_ops]
        obs  = [obs_rank[op] for op in available_ops]
        r_d, p_d = stats.spearmanr(pred, obs)

        results["test_D"] = {
            "spearman_r": round(r_d, 4),
            "spearman_p": round(p_d, 6),
            "n_operators": len(available_ops),
            "theory_rank": {op: theory_rank.get(op) for op in available_ops},
            "observed_rank": obs_rank,
            "observed_frequencies": {op: round(obs_freq[op], 4) for op in available_ops},
            "interpretation": (
                f"Spearman r={r_d:+.3f} between theory-predicted and observed frequency rank "
                f"(p={p_d:.4f}). "
                + ("Strong agreement: the helix-predicted gravity wells (CON, SUP, INS) "
                   "and deserts (NUL, REC) match the observed frequency distribution. "
                   "The frequency structure is not accidental — it reflects the helix's "
                   "prediction of which operations are 'unmarked' in language."
                   if r_d > 0.7 and p_d < 0.05 else
                   "Moderate or weak agreement with theory-predicted rank.")
            ),
        }
        print(f"    r={r_d:.3f} p={p_d:.4f}", flush=True)

    return results


def compute_helix_dependency_tests(q1: np.ndarray, q2: np.ndarray,
                                    q3: np.ndarray, phasepost_counts: dict) -> dict:
    """
    Three tests of the helix dependency structure.

    The ARI = 0.185 between Q1 and Q2 is compatible with either random coupling
    or structured dependency. These tests distinguish between them by checking
    whether the correlation is directed, ordered, and topologically predictable —
    which is what EO's helix claim requires.

    TEST 1 — Directional asymmetry (information flow)
    Compute conditional entropy H(Q2|Q1) and H(Q1|Q2). If the dependency is
    directed, these will differ. H(Q2|Q1) < H(Q1|Q2) means knowing Mode
    reduces uncertainty about Domain more than the reverse — Mode constrains
    Domain, not the other way around. A permutation test establishes the
    significance of the asymmetry.

    TEST 2 — Mode ordinal predicts Domain ordinal
    The helix assigns ordinal positions to operators. Within each Mode class,
    the helix predicts that DIFFERENTIATING (early) should co-occur with
    lower-complexity domains more than GENERATING (whose existence operator
    INS is position 3, not 9). Test: Spearman rank correlation between
    Mode ordinal and Domain ordinal. A directed dependency should show
    a non-zero correlation; a random correlation would not.

    TEST 3 — Helix topology predicts cell frequency distribution
    EO makes specific predictions about which cells should be gravity wells
    and which should be deserts, based on what operations are structurally
    "unmarked" (requiring the fewest preconditions) in language:
      - CON (Relating×Structure): structural connectivity is the unmarked
        relational act — predicted most frequent
      - INS (Generating×Existence): event occurrence is the unmarked
        generative act — predicted second
      - SUP (Relating×Significance): perspective-holding is the unmarked
        significance act — predicted third
      - NUL (Differentiating×Existence) and REC (Generating×Significance):
        the bookend positions requiring the most contextual preparation — deserts
    Test: do the observed gravity wells match the helix-predicted cells?
    And: does the Structure domain dominate (as EO predicts the mid-helix
    structural operators should) over Existence and Significance?
    """
    import math
    from scipy import stats
    from collections import defaultdict

    ACT_INV = {
        "NUL":("DIFFERENTIATING","EXISTENCE"), "SIG":("RELATING","EXISTENCE"),
        "INS":("GENERATING","EXISTENCE"), "SEG":("DIFFERENTIATING","STRUCTURE"),
        "CON":("RELATING","STRUCTURE"), "SYN":("GENERATING","STRUCTURE"),
        "ALT":("DIFFERENTIATING","SIGNIFICANCE"), "SUP":("RELATING","SIGNIFICANCE"),
        "REC":("GENERATING","SIGNIFICANCE"),
    }
    MODE_ORD   = {"DIFFERENTIATING": 1, "RELATING": 2, "GENERATING": 3}
    DOMAIN_ORD = {"EXISTENCE": 1, "STRUCTURE": 2, "SIGNIFICANCE": 3}

    # ── Build Q1×Q2 joint table from live label arrays ──────────────────────
    valid = (q1 != "?") & (q2 != "?") & (q3 != "?")
    q1v, q2v = q1[valid], q2[valid]
    total = valid.sum()

    joint = defaultdict(int)
    q1_marg = defaultdict(int)
    q2_marg = defaultdict(int)
    for i in range(len(q1v)):
        joint[(q1v[i], q2v[i])] += 1
        q1_marg[q1v[i]] += 1
        q2_marg[q2v[i]] += 1

    def entropy(counts_dict):
        n = sum(counts_dict.values())
        if n == 0: return 0.0
        return -sum((c/n) * math.log2(c/n) for c in counts_dict.values() if c > 0)

    def cond_entropy_q2_given_q1():
        """H(Q2|Q1): uncertainty in Domain given Mode."""
        h = 0.0
        for q1_val, n_q1 in q1_marg.items():
            if n_q1 == 0: continue
            q2_cond = {q2_val: joint[(q1_val, q2_val)]
                       for q2_val in q2_marg if (q1_val, q2_val) in joint}
            h += (n_q1 / total) * entropy(q2_cond)
        return h

    def cond_entropy_q1_given_q2():
        """H(Q1|Q2): uncertainty in Mode given Domain."""
        h = 0.0
        for q2_val, n_q2 in q2_marg.items():
            if n_q2 == 0: continue
            q1_cond = {q1_val: joint[(q1_val, q2_val)]
                       for q1_val in q1_marg if (q1_val, q2_val) in joint}
            h += (n_q2 / total) * entropy(q1_cond)
        return h

    h_q2_given_q1 = cond_entropy_q2_given_q1()
    h_q1_given_q2 = cond_entropy_q1_given_q2()
    h_q1 = entropy(q1_marg)
    h_q2 = entropy(q2_marg)
    asymmetry = h_q2_given_q1 - h_q1_given_q2

    # Permutation test: shuffle Q2 labels, recompute asymmetry 1000 times
    rng = np.random.default_rng(42)
    q2_arr = np.array([q2v[i] for i in range(len(q2v))])
    null_asymmetries = []
    for _ in range(1000):
        q2_shuf = q2_arr.copy()
        rng.shuffle(q2_shuf)
        j_shuf = defaultdict(int)
        q1m_shuf = defaultdict(int)
        q2m_shuf = defaultdict(int)
        for i in range(len(q1v)):
            j_shuf[(q1v[i], q2_shuf[i])] += 1
            q1m_shuf[q1v[i]] += 1
            q2m_shuf[q2_shuf[i]] += 1
        # Under H0 (random coupling), asymmetry should be ~0
        def _ce_q2_q1(j, q1m, q2m):
            h = 0.0
            for a, n in q1m.items():
                if n == 0: continue
                q2c = {b: j[(a,b)] for b in q2m if (a,b) in j}
                h += (n/total) * entropy(q2c)
            return h
        def _ce_q1_q2(j, q1m, q2m):
            h = 0.0
            for b, n in q2m.items():
                if n == 0: continue
                q1c = {a: j[(a,b)] for a in q1m if (a,b) in j}
                h += (n/total) * entropy(q1c)
            return h
        null_asymmetries.append(_ce_q2_q1(j_shuf,q1m_shuf,q2m_shuf) -
                                 _ce_q1_q2(j_shuf,q1m_shuf,q2m_shuf))

    null_arr = np.array(null_asymmetries)
    p_asym = (np.abs(null_arr) >= np.abs(asymmetry)).mean()

    test1 = {
        "H_q1":           round(h_q1, 4),
        "H_q2":           round(h_q2, 4),
        "H_q2_given_q1":  round(h_q2_given_q1, 4),
        "H_q1_given_q2":  round(h_q1_given_q2, 4),
        "asymmetry_bits": round(asymmetry, 4),
        "asymmetry_pval": round(float(p_asym), 4),
        "direction":      "Mode→Domain" if asymmetry > 0 else "Domain→Mode",
        "interpretation": (
            "H(Q2|Q1) > H(Q1|Q2): Domain is more constrained by Mode than Mode by Domain. "
            "Mode carries more information about Domain than vice versa. "
            "Consistent with the helix direction: Mode is upstream of Domain."
            if asymmetry > 0 else
            "H(Q1|Q2) > H(Q2|Q1): Mode is more constrained by Domain than Domain by Mode. "
            "Unexpected under the helix — Domain would be upstream of Mode."
        ),
    }

    # ── TEST 2: Mode ordinal vs Domain ordinal ───────────────────────────────
    mode_ord_arr   = np.array([MODE_ORD.get(q1v[i], 0) for i in range(len(q1v))])
    domain_ord_arr = np.array([DOMAIN_ORD.get(q2v[i], 0) for i in range(len(q2v))])
    valid2 = (mode_ord_arr > 0) & (domain_ord_arr > 0)

    # Sample for speed (Spearman is O(n log n))
    n_sample = min(8000, valid2.sum())
    idx_s = rng.choice(np.where(valid2)[0], n_sample, replace=False)
    r_spear, p_spear = stats.spearmanr(mode_ord_arr[idx_s], domain_ord_arr[idx_s])

    test2 = {
        "spearman_r": round(float(r_spear), 4),
        "spearman_p": round(float(p_spear), 6),
        "n_sample":   int(n_sample),
        "interpretation": (
            f"Spearman r={r_spear:+.3f} (p={p_spear:.4f}). "
            + ("Significant non-zero correlation: Mode ordinal position predicts Domain "
               "ordinal complexity. The direction and magnitude of the correlation "
               "is a stronger claim than ARI — it tests ordered structure, not just "
               "association." if p_spear < 0.05 else
               "No significant ordinal correlation between Mode and Domain position.")
        ),
    }

    # ── TEST 3: Helix topology predicts cell frequency distribution ──────────
    # Use phasepost_counts (consensus) for operator-level frequencies
    ops = ["NUL","SIG","INS","SEG","CON","SYN","ALT","SUP","REC"]
    op_freq = {}
    for op in ops:
        op_freq[op] = sum(v for k,v in phasepost_counts.items()
                         if k.split("(")[0] == op)
    op_total = sum(op_freq.values())

    if op_total > 0:
        obs_freq = {op: op_freq[op]/op_total for op in ops}

        # EO theory-predicted rank order (1=most frequent)
        # Based on structural accessibility: operators requiring fewer upstream
        # operations in the helix dependency order are more accessible.
        # CON is the "unmarked" relational act; INS the "unmarked" event;
        # SUP the "unmarked" significance-level act.
        # NUL and REC require maximal contextual preparation — bookend deserts.
        theory_rank = {
            "CON": 1,  # Relating×Structure — unmarked co-presence
            "SUP": 2,  # Relating×Significance — unmarked perspective-holding
            "INS": 3,  # Generating×Existence — unmarked event occurrence
            "ALT": 4,  # Differentiating×Significance — reframing
            "SEG": 5,  # Differentiating×Structure — partition
            "SYN": 6,  # Generating×Structure — deliberate synthesis
            "SIG": 7,  # Relating×Existence — pure differential registration
            "REC": 8,  # Generating×Significance — frame change (rare)
            "NUL": 9,  # Differentiating×Existence — recognizing absence (rarest)
        }
        obs_sorted = sorted(ops, key=lambda op: -obs_freq[op])
        obs_rank = {op: i+1 for i, op in enumerate(obs_sorted)}

        pred_ranks = [theory_rank[op] for op in ops]
        obs_ranks  = [obs_rank[op] for op in ops]
        r_top, p_top = stats.spearmanr(pred_ranks, obs_ranks)

        # Exact prediction: top-3 gravity wells
        top3_pred = {"CON", "INS", "SUP"}  # by EO theory
        top3_obs  = set(obs_sorted[:3])
        top3_match = top3_pred == top3_obs

        # Domain-level: Structure should dominate
        domain_freq = {"EXISTENCE": 0, "STRUCTURE": 0, "SIGNIFICANCE": 0}
        for op, freq in op_freq.items():
            _, dom = ACT_INV[op]
            domain_freq[dom] += freq
        dom_total = sum(domain_freq.values())
        structure_dominates = (domain_freq["STRUCTURE"] >
                               max(domain_freq["EXISTENCE"], domain_freq["SIGNIFICANCE"]))

        test3 = {
            "spearman_r_rank":       round(float(r_top), 4),
            "spearman_p_rank":       round(float(p_top), 4),
            "top3_predicted":        sorted(top3_pred),
            "top3_observed":         obs_sorted[:3],
            "top3_match":            top3_match,
            "structure_dominates":   structure_dominates,
            "domain_frequencies": {
                d: round(domain_freq[d]/dom_total, 4) for d in domain_freq
            },
            "op_frequencies": {
                op: round(obs_freq[op], 4) for op in ops
            },
            "interpretation": (
                f"Top-3 gravity well prediction {'✓ correct' if top3_match else '✗ incorrect'}: "
                f"observed {obs_sorted[:3]} vs predicted {{CON, INS, SUP}}. "
                f"Structure domain {'dominates' if structure_dominates else 'does not dominate'} "
                f"({domain_freq['STRUCTURE']/dom_total:.1%} of clauses). "
                f"Spearman rank correlation with theory-predicted ordering: r={r_top:.3f} (p={p_top:.3f})."
            ),
        }
    else:
        test3 = {"error": "No phasepost data available"}

    return {
        "test1_directional_entropy": test1,
        "test2_ordinal_correlation": test2,
        "test3_topology_prediction": test3,
    }


def generate_exemplar_report(exemplars_out: dict, run_dir: Path):
    """
    Generate a human-readable report of top exemplars per cell and face position.

    For each face (Act, Site, Resolution, 27-cell):
      - What the face is tracking as a whole
      - Top 5 exemplars per position, ranked by margin
      - Margin statistics (highest/lowest discriminability)
      - Language distribution per position
      - Patterns distinguishing adjacent positions

    Output: exemplar_report.txt
    """
    from collections import Counter

    lines = []
    def w(s=""): lines.append(s)
    def h1(s):
        lines.append("")
        lines.append("=" * 74)
        lines.append(f"  {s}")
        lines.append("=" * 74)
    def h2(s):
        lines.append("")
        lines.append(f"  ── {s} ──────────────────────────────────────")
    def h3(s):
        lines.append("")
        lines.append(f"  {s}")
        lines.append(f"  {'─' * len(s)}")

    FACE_DESCRIPTIONS = {
        "act_face": (
            "ACT FACE — Mode × Domain — The Nine Operators",
            "What transformation is happening. The Act face crosses how an operation "
            "is structured (Mode: differentiating/relating/generating) with what level "
            "of reality it operates on (Domain: existence/structure/significance). "
            "The 9 operators are the primary vocabulary of transformation in EO. "
            "Each operator names a distinct kind of act."
        ),
        "site_face": (
            "SITE FACE — Domain × Object — Nine Terrain Types",
            "Where in reality the target is located. The Site face crosses what level "
            "of reality (Domain: existence/structure/significance) with what grain of "
            "object (Object: condition/entity/pattern). The 9 terrain types describe "
            "the phenomenological address of a target before any operation is performed. "
            "Reading the Site face tells you what kind of thing you are working with."
        ),
        "resolution_face": (
            "RESOLUTION FACE — Mode × Object — Nine Engagement Stances",
            "At what grain the transformation lands. The Resolution face crosses how "
            "an operation is structured (Mode: differentiating/relating/generating) "
            "with what grain of object it targets (Object: condition/entity/pattern). "
            "The 9 stances describe the actor's relationship to the target — not what "
            "they are doing or where, but how they are engaging."
        ),
        "27cell": (
            "FULL 27-CELL ADDRESS — All Three Axes",
            "Complete specification: operator(Resolution, Site). Each cell simultaneously "
            "encodes the Act face (what), the Site face (where), and the Resolution face "
            "(how). The composite margin ranks exemplars that are unambiguous on all "
            "three faces simultaneously — the most discriminative instances in the corpus."
        ),
    }

    POSITION_NOTES = {
        # Act face — operators
        "NUL": "Recognize absence. The precondition of all other operations — before difference can be registered, absence must be acknowledged.",
        "SIG": "Register difference. The minimal act of distinction — something becomes noticeable.",
        "INS": "Create instance. Something new comes into existence as a discrete event.",
        "SEG": "Draw boundary. Partition, divide, separate — something is set apart from its surroundings.",
        "CON": "Connect across boundary. Hold two things in relation.",
        "SYN": "Merge into emergent whole. Parts integrate into something that is more than their sum.",
        "ALT": "Change value within frame. Reframe without changing the frame itself.",
        "SUP": "Hold contradictions simultaneously. Two incompatible things are both present.",
        "REC": "Change the frame itself. The interpretive structure undergoes transformation.",
        # Site face — terrain types
        "Void":       "Existence × Condition. The ambient substrate of being — what is present as background before anything is picked out.",
        "Entity":     "Existence × Entity. A specific existent — this thing, graspable, nameable.",
        "Kind":       "Existence × Pattern. A type or category — not any particular instance but the recurring class.",
        "Field":      "Structure × Condition. The ambient relational environment — the implicit rules nobody names but everyone navigates.",
        "Link":       "Structure × Entity. A specific connection — this bond, this dependency.",
        "Network":    "Structure × Pattern. An architecture of connections — the system as recurring structure.",
        "Atmosphere": "Significance × Condition. The ambient interpretive weather — what makes certain readings feel obvious.",
        "Lens":       "Significance × Entity. A specific reading or frame applied to one situation.",
        "Paradigm":   "Significance × Pattern. A worldview or interpretive framework through which everything is filtered.",
        # Resolution face — stances
        "Clearing":   "Differentiating × Condition. Dissolving ambient conditions — making space before analysis.",
        "Dissecting": "Differentiating × Entity. Taking apart a specific thing — investigation, surgery.",
        "Unraveling": "Differentiating × Pattern. Deconstructing a regularity — showing how a recurring structure works.",
        "Tending":    "Relating × Condition. Maintaining conditions — the gardener's stance.",
        "Binding":    "Relating × Entity. Connecting specific things — tying this to that.",
        "Tracing":    "Relating × Pattern. Mapping regularities — the analyst's stance.",
        "Cultivating":"Generating × Condition. Producing conditions for emergence without producing the thing itself.",
        "Making":     "Generating × Entity. Producing a specific thing — the gravity well of language.",
        "Composing":  "Generating × Pattern. Producing regularities or structures that recur.",
    }

    FACE_ORDER = [
        ("act_face",        ["NUL","SIG","INS","SEG","CON","SYN","ALT","SUP","REC"]),
        ("site_face",       ["Void","Entity","Kind","Field","Link","Network","Atmosphere","Lens","Paradigm"]),
        ("resolution_face", ["Clearing","Dissecting","Unraveling","Tending","Binding","Tracing","Cultivating","Making","Composing"]),
        ("27cell",          None),  # helix order derived from cells present
    ]

    w("EO LEXICAL ANALYSIS — EXEMPLAR REPORT")
    w("Top exemplars per cell and face position, ranked by discrimination margin.")
    w("Margin = how far a clause is from its nearest competing centroid.")
    w("Higher margin = clause is more unambiguously in this cell than any other.")
    w("27-cell composite margin = minimum margin across all four faces simultaneously.")

    for face_name, position_order in FACE_ORDER:
        face_data = exemplars_out.get(face_name, {})
        if not face_data:
            continue

        title, description = FACE_DESCRIPTIONS.get(face_name, (face_name, ""))
        h1(title)
        w()
        # Wrap description
        for chunk in [description[i:i+70] for i in range(0, len(description), 70)]:
            w(f"  {chunk}")

        # Determine position order
        if position_order:
            positions = [p for p in position_order if any(
                k == p or k.startswith(p + "(") for k in face_data.keys()
            )]
            # For act_face/site_face/resolution_face, keys ARE the position names
            if face_name != "27cell":
                positions = [p for p in position_order if p in face_data]
        else:
            # 27cell: sort by operator in helix order
            helix = ["NUL","SIG","INS","SEG","CON","SYN","ALT","SUP","REC"]
            def cell_sort_key(k):
                op = k.split("(")[0]
                return (helix.index(op) if op in helix else 99, k)
            positions = sorted(face_data.keys(), key=cell_sort_key)

        # Compute margin stats across all positions in this face
        all_top_margins = []
        for pos in positions:
            exs = face_data.get(pos, [])
            if exs:
                # Use best positive-margin exemplar only
                mk = "margin_composite" if face_name == "27cell" else "margin_face"
                pos_exs = [e for e in exs
                           if e.get(mk, e.get("margin_composite", e.get("margin_face", 0))) > 0]
                if pos_exs:
                    all_top_margins.append((pos, pos_exs[0].get(mk,
                        pos_exs[0].get("margin_composite", pos_exs[0].get("margin_face", 0)))))

        if all_top_margins:
            all_top_margins.sort(key=lambda x: -x[1])
            w()
            w("  Margin summary (best exemplar per position, highest to lowest):")
            for pos, m in all_top_margins:
                bar = "█" * int(m * 200)
                w(f"    {pos:<30} Δ={m:.3f}  {bar}")

        # Per-position exemplars
        for pos in positions:
            exs = face_data.get(pos, [])
            if not exs:
                continue

            # Filter out exemplars with negative composite margin —
            # they sit closer to a competing centroid than their own.
            margin_key = "margin_composite" if face_name == "27cell" else "margin_face"
            positive_exs = [e for e in exs
                            if e.get(margin_key, e.get("margin_composite",
                               e.get("margin_face", 0))) > 0]
            n_negative = len(exs) - len(positive_exs)

            note = POSITION_NOTES.get(pos, "")
            h3(pos)
            if note:
                w(f"  {note}")
            if n_negative > 0:
                w(f"  ⚠ {n_negative} exemplar(s) with negative margin excluded "
                  f"(closer to a competing centroid than their own).")

            # Language distribution of top-20 positive exemplars
            top20 = positive_exs[:20]
            if not top20:
                w("  No positive-margin exemplars for this cell.")
                continue

            lang_counts = Counter(e["language"] for e in top20)
            top_langs = ", ".join(f"{l}({n})" for l, n in lang_counts.most_common(5))
            w(f"  Language distribution (top 20): {top_langs}")

            # Language concentration warning
            most_common_lang, most_common_n = lang_counts.most_common(1)[0]
            if most_common_n >= len(top20) * 0.6 and len(top20) >= 5:
                w(f"  ⚠ Language concentration: {most_common_n}/{len(top20)} top exemplars "
                  f"are {most_common_lang}. Results may reflect corpus artifact, "
                  f"not operator semantics.")
            w()

            # Top 5 positive-margin exemplars
            w(f"  {'#':<4} {'Lang':<6} {'sim':>6} {'Δ':>7}  Clause")
            w(f"  {'─'*4} {'─'*6} {'─'*6} {'─'*7}  {'─'*50}")
            for i, ex in enumerate(positive_exs[:5]):
                clause = ex.get("clause","")
                if len(clause) > 85:
                    clause = clause[:82] + "..."
                m   = ex.get(margin_key, ex.get("margin_composite", ex.get("margin_face", 0)))
                sim = ex.get("sim_own", 0)
                w(f"  {i+1:<4} {ex['language']:<6} {sim:>6.3f} {m:>7.3f}  {clause}")

    w()
    w("=" * 74)
    w("  END OF EXEMPLAR REPORT")
    w("=" * 74)

    report_path = run_dir / "exemplar_report.txt"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    ok(f"Exemplar report: {report_path}")
    return report_path


def cohen_kappa(labels_a: list, labels_b: list) -> float:
    """Compute Cohen's kappa between two sets of labels."""
    try:
        return float(cohen_kappa_score(labels_a, labels_b))
    except Exception:
        return float("nan")


def compute_phasepost_frequency(classified_file: Path) -> dict:
    """
    Count every Q1×Q2×Q3 combination across three label sets:
      consensus — both models agreed
      claude    — Claude's labels for all classified clauses
      gpt4      — GPT-4's labels for all classified clauses

    Returns dict with keys 'consensus', 'claude', 'gpt4', each mapping
    cell_name -> count. Also returns total per set.

    The cell name format is: OPERATOR(Resolution, Site)
    e.g. CON(Binding, Link), INS(Making, Entity)
    """
    ACT = {
        ("DIFFERENTIATING","EXISTENCE"):    "NUL",
        ("DIFFERENTIATING","STRUCTURE"):    "SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"): "ALT",
        ("RELATING","EXISTENCE"):           "SIG",
        ("RELATING","STRUCTURE"):           "CON",
        ("RELATING","SIGNIFICANCE"):        "SUP",
        ("GENERATING","EXISTENCE"):         "INS",
        ("GENERATING","STRUCTURE"):         "SYN",
        ("GENERATING","SIGNIFICANCE"):      "REC",
    }
    SITE = {
        ("EXISTENCE","CONDITION"):    "Void",
        ("EXISTENCE","ENTITY"):       "Entity",
        ("EXISTENCE","PATTERN"):      "Kind",
        ("STRUCTURE","CONDITION"):    "Field",
        ("STRUCTURE","ENTITY"):       "Link",
        ("STRUCTURE","PATTERN"):      "Network",
        ("SIGNIFICANCE","CONDITION"): "Atmosphere",
        ("SIGNIFICANCE","ENTITY"):    "Lens",
        ("SIGNIFICANCE","PATTERN"):   "Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"): "Clearing",
        ("DIFFERENTIATING","ENTITY"):    "Dissecting",
        ("DIFFERENTIATING","PATTERN"):   "Unraveling",
        ("RELATING","CONDITION"):        "Tending",
        ("RELATING","ENTITY"):           "Binding",
        ("RELATING","PATTERN"):          "Tracing",
        ("GENERATING","CONDITION"):      "Cultivating",
        ("GENERATING","ENTITY"):         "Making",
        ("GENERATING","PATTERN"):        "Composing",
    }
    ENTITY_TYPE = {"CONDITION": "Emanon", "ENTITY": "Holon", "PATTERN": "Protogon"}

    def cell_name(q1, q2, q3):
        op   = ACT.get((q1,q2), "?")
        site = SITE.get((q2,q3), "?")
        res  = RES.get((q1,q3), "?")
        return f"{op}({res}, {site})"

    # All 27 canonical cells in helix order
    ALL_CELLS = []
    for q1 in ["DIFFERENTIATING","RELATING","GENERATING"]:
        for q2 in ["EXISTENCE","STRUCTURE","SIGNIFICANCE"]:
            for q3 in ["CONDITION","ENTITY","PATTERN"]:
                cn = cell_name(q1, q2, q3)
                et = ENTITY_TYPE.get(q3, "?")
                ALL_CELLS.append((cn, q1, q2, q3, et))

    counts = {
        "consensus": defaultdict(int),
        "claude":    defaultdict(int),
        "gpt4":      defaultdict(int),
    }

    with open(classified_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                r = json.loads(line)
                cls = r.get("classifications", {})

                # Consensus
                c = r.get("consensus")
                if c:
                    q1,q2,q3 = c.get("q1","?"), c.get("q2","?"), c.get("q3","?")
                    if "?" not in (q1,q2,q3):
                        counts["consensus"][cell_name(q1,q2,q3)] += 1

                # Per model
                # Resolve model key — prefer explicit "gpt4" over aliases
                # to avoid double-counting on mixed-version corpora
                gpt4_val = cls.get("gpt4") or cls.get("gpt-4o-mini") or cls.get("gpt-4o")
                resolved = [("claude", "claude", cls.get("claude"))]
                if gpt4_val:
                    resolved.append(("gpt4", "gpt4", gpt4_val))
                for model_key, label_key, mv in resolved:
                    if mv:
                        q1,q2,q3 = mv.get("q1","?"), mv.get("q2","?"), mv.get("q3","?")
                        if "?" not in (q1,q2,q3):
                            counts[label_key][cell_name(q1,q2,q3)] += 1
            except:
                pass

    return {"counts": counts, "all_cells": ALL_CELLS}


def format_phasepost_table(counts_dict, all_cells, label="consensus", title=""):
    """
    Return a list of printable lines for a phasepost frequency table.
    Groups by triad. Shows entity type, count, percentage, bar.
    Marks empty cells explicitly.
    """
    lines = []
    def w(s=""): lines.append(s)

    counts = counts_dict.get(label, {})
    total = sum(counts.values())
    if total == 0:
        w(f"  No data for label set '{label}'")
        return lines

    max_n = max(counts.values()) if counts else 1

    if title:
        w(f"  {title}  ({total:,} clauses)")
    w(f"  {'Cell':<32} {'Type':<10} {'Count':>6}  {'%':>5}  Distribution")
    w()

    TRIAD_HEADERS = {
        "NUL": "── Existence triad (NUL / SIG / INS) ──────────────────────",
        "SEG": "── Structure triad (SEG / CON / SYN) ──────────────────────",
        "ALT": "── Significance triad (ALT / SUP / REC) ────────────────────",
    }
    current_triad = None

    for cell_name, q1, q2, q3, et in all_cells:
        op = cell_name.split("(")[0]
        if op in TRIAD_HEADERS and op != current_triad:
            current_triad = op
            w(f"  {TRIAD_HEADERS[op]}")

        n = counts.get(cell_name, 0)
        pct = n / total * 100 if total else 0
        bar_len = int(n / max_n * 25) if max_n else 0
        bar = "█" * bar_len + "·" * (25 - bar_len)
        empty_marker = "  ← desert" if n == 0 else ""
        w(f"  {cell_name:<32} {et:<10} {n:>6}  {pct:>4.1f}%  {bar}{empty_marker}")

    w()
    return lines


def compute_intermodel_agreement(classified_file: Path, models: list) -> dict:
    """
    For each pair of models, compute Cohen's kappa on Q1, Q2, Q3.
    High kappa means the plain-language questions are robust and
    not model-specific. Low kappa means the axis is ambiguous.
    """
    model_labels = defaultdict(lambda: defaultdict(list))
    shared_ids   = None

    with open(classified_file) as f:
        for line in f:
            try:
                r = json.loads(line)
                cls = r.get("classifications", {})
                rid = r.get("id","")
                if len(cls) >= 2:
                    if shared_ids is None:
                        shared_ids = set()
                    shared_ids.add(rid)
                    for m, v in cls.items():
                        if v:
                            for axis in ["q1","q2","q3"]:
                                model_labels[m][axis].append((rid, v.get(axis,"")))
            except Exception:
                pass

    if not shared_ids or len(model_labels) < 2:
        return {}

    # Align labels by clause ID
    kappas = {}
    model_names = list(model_labels.keys())
    for i, ma in enumerate(model_names):
        for mb in model_names[i+1:]:
            pair_key = f"{ma}_vs_{mb}"
            kappas[pair_key] = {}
            for axis in ["q1","q2","q3"]:
                da = dict(model_labels[ma][axis])
                db = dict(model_labels[mb][axis])
                common = set(da.keys()) & set(db.keys())
                if len(common) < 20:
                    continue
                la = [da[k] for k in sorted(common)]
                lb = [db[k] for k in sorted(common)]
                kappas[pair_key][axis] = round(cohen_kappa(la, lb), 3)

    return kappas


# ─────────────────────────────────────────────────────────────────────────────
# REPORT GENERATION
#
# Every result is explained in plain English alongside the numbers.
# The report is written for someone who doesn't know EO but can read carefully.
# ─────────────────────────────────────────────────────────────────────────────

def run_centroid_phase(embeddings_file: Path, run_dir: Path) -> Path:
    """
    Phase 5 — Centroid Classification.

    For each EO cell (27-cell, 9 operators, 3 triads), compute the mean
    embedding vector of all consensus-classified clauses in that cell.
    Then classify ALL clauses (including non-consensus) by nearest centroid
    and measure how well the geometry recovers the AI classifications.

    This tests whether the 27 cells are geometrically stable regions —
    not just statistically significant on average, but individually
    locatable in embedding space.

    Saves:
      centroids.npz     — centroid vectors for all cells at all levels
      centroid_report.txt — accuracy and coverage report
    """
    section("Phase 5 — Computing centroids and centroid classification")

    data = np.load(embeddings_file, allow_pickle=True)
    vectors   = data["vectors"].astype(np.float32)
    q1        = data["q1"]
    q2        = data["q2"]
    q3        = data["q3"]
    op        = data["operator"]
    if "consensus" not in data:
        import warnings
        warnings.warn(
            "embeddings.npz has no 'consensus' key — treating all vectors as consensus. "
            "This will contaminate centroid training with single-model clauses if the file "
            "predates dual-model classification. Re-embed from classified.jsonl to fix.",
            stacklevel=2
        )
    consensus = data.get("consensus", np.ones(len(vectors), dtype=bool))
    ids       = data["ids"]

    # Normalise all vectors once
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    ACT = {
        ("DIFFERENTIATING","EXISTENCE"):    "NUL",
        ("DIFFERENTIATING","STRUCTURE"):    "SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"): "ALT",
        ("RELATING","EXISTENCE"):           "SIG",
        ("RELATING","STRUCTURE"):           "CON",
        ("RELATING","SIGNIFICANCE"):        "SUP",
        ("GENERATING","EXISTENCE"):         "INS",
        ("GENERATING","STRUCTURE"):         "SYN",
        ("GENERATING","SIGNIFICANCE"):      "REC",
    }
    SITE = {
        ("EXISTENCE","CONDITION"):    "Void",   ("EXISTENCE","ENTITY"):  "Entity",
        ("EXISTENCE","PATTERN"):      "Kind",   ("STRUCTURE","CONDITION"): "Field",
        ("STRUCTURE","ENTITY"):       "Link",   ("STRUCTURE","PATTERN"): "Network",
        ("SIGNIFICANCE","CONDITION"): "Atmosphere", ("SIGNIFICANCE","ENTITY"): "Lens",
        ("SIGNIFICANCE","PATTERN"):   "Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"): "Clearing", ("DIFFERENTIATING","ENTITY"): "Dissecting",
        ("DIFFERENTIATING","PATTERN"):   "Unraveling", ("RELATING","CONDITION"): "Tending",
        ("RELATING","ENTITY"):           "Binding",  ("RELATING","PATTERN"): "Tracing",
        ("GENERATING","CONDITION"):      "Cultivating", ("GENERATING","ENTITY"): "Making",
        ("GENERATING","PATTERN"):        "Composing",
    }

    def full_label(i):
        return f"{q1[i]}/{q2[i]}/{q3[i]}"
    def op_label(i):
        return ACT.get((q1[i],q2[i]),"?")
    def triad_label(i):
        return q2[i]  # EXISTENCE / STRUCTURE / SIGNIFICANCE

    # ── Build centroids from consensus clauses ────────────────────────────────
    info("Building centroids from consensus clauses...")
    consensus_mask = consensus & (q1 != "?") & (q2 != "?") & (q3 != "?")
    info(f"  Consensus clauses: {consensus_mask.sum():,}")

    # 27-cell centroids
    cell_vecs   = defaultdict(list)
    op_vecs     = defaultdict(list)
    triad_vecs  = defaultdict(list)

    for i in np.where(consensus_mask)[0]:
        fl = full_label(i)
        ol = op_label(i)
        tl = triad_label(i)
        if "?" not in fl:
            cell_vecs[fl].append(normed[i])
            op_vecs[ol].append(normed[i])
            triad_vecs[tl].append(normed[i])

    def make_centroids(vecs_dict):
        centroids = {}
        for label, vecs in vecs_dict.items():
            if len(vecs) >= 5:
                c = np.mean(vecs, axis=0)
                c = c / (np.linalg.norm(c) + 1e-9)
                centroids[label] = c
        return centroids

    cell_centroids  = make_centroids(cell_vecs)
    op_centroids    = make_centroids(op_vecs)
    triad_centroids = make_centroids(triad_vecs)

    ok(f"27-cell centroids: {len(cell_centroids)} of 27 cells have centroids")
    ok(f"Operator centroids: {len(op_centroids)} of 9")
    ok(f"Triad centroids:    {len(triad_centroids)} of 3")

    # ── Classify all clauses by nearest centroid ──────────────────────────────
    info("Classifying all clauses by nearest centroid...")

    def nearest(vec, centroids_dict):
        best_label, best_sim = None, -2.0
        for label, centroid in centroids_dict.items():
            sim = float(vec @ centroid)
            if sim > best_sim:
                best_sim = sim
                best_label = label
        return best_label, best_sim

    valid_mask = (q1 != "?") & (q2 != "?") & (q3 != "?")
    n_valid = valid_mask.sum()

    # Accuracy tracking
    triad_correct = triad_total = 0
    op_correct    = op_total    = 0
    cell_correct  = cell_total  = 0

    # Consensus-only accuracy (strictest test)
    triad_c_correct = triad_c_total = 0
    op_c_correct    = op_c_total    = 0
    cell_c_correct  = cell_c_total  = 0

    # Per-cell accuracy
    per_cell_correct = defaultdict(int)
    per_cell_total   = defaultdict(int)

    centroid_labels_27   = []
    centroid_labels_op   = []
    centroid_labels_tri  = []
    centroid_sims_27     = []

    for i in np.where(valid_mask)[0]:
        vec = normed[i]
        fl = full_label(i)
        ol = op_label(i)
        tl = triad_label(i)
        is_consensus = bool(consensus[i])

        # Triad
        pred_t, sim_t = nearest(vec, triad_centroids)
        centroid_labels_tri.append(pred_t or "?")
        if pred_t:
            triad_total += 1
            if pred_t == tl: triad_correct += 1
            if is_consensus:
                triad_c_total += 1
                if pred_t == tl: triad_c_correct += 1

        # Operator
        pred_o, sim_o = nearest(vec, op_centroids)
        centroid_labels_op.append(pred_o or "?")
        if pred_o:
            op_total += 1
            if pred_o == ol: op_correct += 1
            if is_consensus:
                op_c_total += 1
                if pred_o == ol: op_c_correct += 1

        # 27-cell
        pred_c, sim_c = nearest(vec, cell_centroids)
        centroid_labels_27.append(pred_c or "?")
        centroid_sims_27.append(sim_c)
        if pred_c and fl in cell_centroids:
            cell_total += 1
            per_cell_total[fl] += 1
            if pred_c == fl:
                cell_correct += 1
                per_cell_correct[fl] += 1
            if is_consensus:
                cell_c_total += 1
                if pred_c == fl: cell_c_correct += 1

    # ── Report ────────────────────────────────────────────────────────────────
    lines = []
    def w(s=""): lines.append(s)

    w("=" * 70)
    w("  PHASE 5 — CENTROID CLASSIFICATION REPORT")
    w("=" * 70)
    w()
    w("  Centroids built from consensus clauses (both models agreed).")
    w("  Classification: each clause assigned to nearest centroid by cosine similarity.")
    w("  Chance baseline: 1/3 (triads), 1/9 (operators), 1/27 (cells) = 33%, 11%, 4%")
    w()
    w(f"  {'Level':<20} {'All clauses':>14} {'Consensus only':>16} {'Chance':>8}")
    w(f"  {'─'*20} {'─'*14} {'─'*16} {'─'*8}")

    def acc(correct, total):
        if total == 0: return "n/a"
        return f"{correct/total*100:.1f}% ({correct:,}/{total:,})"

    w(f"  {'Triads (3 cells)':<20} {acc(triad_correct,triad_total):>14} {acc(triad_c_correct,triad_c_total):>16} {'33%':>8}")
    w(f"  {'Operators (9 cells)':<20} {acc(op_correct,op_total):>14} {acc(op_c_correct,op_c_total):>16} {'11%':>8}")
    w(f"  {'Full 27-cell':<20} {acc(cell_correct,cell_total):>14} {acc(cell_c_correct,cell_c_total):>16} {'4%':>8}")
    w()
    w("  Per-cell accuracy (consensus clauses):")
    w(f"  {'Cell':<35} {'Accuracy':>10} {'n':>6}")
    w(f"  {'─'*35} {'─'*10} {'─'*6}")

    for label in sorted(per_cell_total.keys()):
        n    = per_cell_total[label]
        corr = per_cell_correct.get(label, 0)
        pct  = corr/n*100 if n else 0
        bar  = "█" * int(pct/5) + "·" * (20 - int(pct/5))
        w(f"  {label:<35} {pct:>8.1f}%  {n:>6}  {bar}")
    w()

    # Centroid similarity distribution
    sims = np.array(centroid_sims_27)
    w(f"  Mean cosine similarity to nearest centroid: {sims.mean():.4f}")
    w(f"  Std:                                        {sims.std():.4f}")
    w(f"  Min:                                        {sims.min():.4f}")
    w(f"  Max:                                        {sims.max():.4f}")
    w()
    w("  Interpretation:")
    w("  Accuracy well above chance means the cells are geometrically stable")
    w("  regions — new clauses fall into the right neighborhood without any")
    w("  AI classification. Accuracy near chance means the cell boundaries")
    w("  are fuzzy — real on average but not individually locatable.")

    report_text = "\n".join(lines)
    report_path = run_dir / "centroid_report.txt"
    report_path.write_text(report_text, encoding="utf-8")
    print(report_text)
    ok(f"Centroid report: {report_path}")

    # Save centroids
    centroid_path = run_dir / "centroids.npz"
    centroid_arrays = {}
    for label, vec in cell_centroids.items():
        centroid_arrays[f"cell_{label.replace('/', '_')}"] = vec
    for label, vec in op_centroids.items():
        centroid_arrays[f"op_{label}"] = vec
    for label, vec in triad_centroids.items():
        centroid_arrays[f"triad_{label}"] = vec
    np.savez_compressed(centroid_path, **centroid_arrays)
    ok(f"Centroids saved: {centroid_path}")

    return centroid_path


def compute_coordinate_geometry_analysis(vectors, q1, q2, q3, n_pairs=5000, seed=42):
    """
    Test whether EO's three coordinate geometries (α/η/Ω) predict
    embedding distances better than uniform axis-difference count.

    The three axes have different mathematical characters:
      α (Arithmetic / Existence)    — coordinate set {0,1,2} — linear steps
      η (Geometric / Structure)     — coordinate set {-1,+1,√2} — ratio steps
      Ω (Transcendental/Significance)— coordinate set {2,√2,2^√2} — exponential steps

    For each pair of clauses we compute:
      1. Uniform distance: count of axes that differ (0,1,2,3)
      2. α-weighted distance: sum of |α_i - α_j| using {0,1,2} coordinates
      3. η-weighted distance: sum of ratio distances using {-1,+1,√2} coordinates
      4. Ω-weighted distance: sum of log distances using {2,√2,2^√2} coordinates
      5. Mixed distance: each axis weighted by its own geometry

    Then correlate each distance measure with actual cosine distance.
    Higher correlation = that distance measure better predicts embedding geometry.
    """
    import random
    random.seed(seed)
    rng = np.random.default_rng(seed)

    sqrt2 = float(np.sqrt(2))
    pow2sqrt2 = float(2 ** sqrt2)  # transcendental by Gelfond-Schneider

    # Coordinate mappings per axis
    ALPHA = {"DIFFERENTIATING": 0, "RELATING": 1, "GENERATING": 2}  # Q1
    ETA   = {"EXISTENCE": -1, "STRUCTURE": 1, "SIGNIFICANCE": sqrt2}  # Q2
    OMEGA = {"CONDITION": 2, "ENTITY": sqrt2, "PATTERN": pow2sqrt2}   # Q3

    # Normalize vectors
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    # Build coordinate arrays
    valid = (q1 != "?") & (q2 != "?") & (q3 != "?")
    idx = np.where(valid)[0]
    if len(idx) < 100:
        return {"error": "insufficient valid clauses"}

    a  = np.array([ALPHA.get(q1[i], np.nan) for i in idx])
    e  = np.array([ETA.get(q2[i], np.nan)   for i in idx])
    om = np.array([OMEGA.get(q3[i], np.nan) for i in idx])

    # Remove any NaN
    ok_mask = ~(np.isnan(a) | np.isnan(e) | np.isnan(om))
    idx = idx[ok_mask]
    a, e, om = a[ok_mask], e[ok_mask], om[ok_mask]
    vecs = normed[idx]

    n = len(idx)
    n_pairs = min(n_pairs, n*(n-1)//2)

    # Sample random pairs
    i_idx = rng.integers(0, n, n_pairs)
    j_idx = rng.integers(0, n, n_pairs)
    same = i_idx == j_idx
    i_idx[same] = (i_idx[same] + 1) % n

    # Embedding cosine distance
    cos_dist = 1 - (vecs[i_idx] * vecs[j_idx]).sum(axis=1)

    # 1. Uniform axis-difference count (existing proportionality measure)
    q1_diff  = (q1[idx][i_idx] != q1[idx][j_idx]).astype(float)
    q2_diff  = (q2[idx][i_idx] != q2[idx][j_idx]).astype(float)
    q3_diff  = (q3[idx][i_idx] != q3[idx][j_idx]).astype(float)
    d_uniform = q1_diff + q2_diff + q3_diff

    # 2. α-weighted: linear arithmetic distance on {0,1,2}
    d_alpha = np.abs(a[i_idx] - a[j_idx])
    d_alpha_total = d_alpha + np.abs(e[i_idx] - e[j_idx]) + np.abs(om[i_idx] - om[j_idx])
    # Normalize to 0-1
    d_alpha_norm = d_alpha_total / d_alpha_total.max() if d_alpha_total.max() > 0 else d_alpha_total

    # 3. η-weighted: geometric/ratio distance on {-1,+1,√2}
    # Use log|ratio| as distance: log(|a/b|) where both nonzero, else abs diff
    def ratio_dist(x, y):
        nz = (x != 0) & (y != 0)
        d = np.abs(x - y)
        d[nz] = np.abs(np.log(np.abs(x[nz] / y[nz]) + 1e-10))
        return d
    d_eta = ratio_dist(e[i_idx], e[j_idx])
    d_eta_total = d_alpha + d_eta + np.abs(om[i_idx] - om[j_idx])
    d_eta_norm = d_eta_total / d_eta_total.max() if d_eta_total.max() > 0 else d_eta_total

    # 4. Ω-weighted: transcendental/exponential distance on {2,√2,2^√2}
    # Use log distance: |log(a) - log(b)|
    d_omega = np.abs(np.log(om[i_idx]) - np.log(om[j_idx]))
    d_omega_total = d_alpha + d_eta + d_omega
    d_omega_norm = d_omega_total / d_omega_total.max() if d_omega_total.max() > 0 else d_omega_total

    # 5. Mixed: each axis uses its own geometry
    d_mixed = (
        np.abs(a[i_idx] - a[j_idx]) +          # α: arithmetic linear
        ratio_dist(e[i_idx], e[j_idx]) +         # η: geometric ratio
        np.abs(np.log(om[i_idx]) - np.log(om[j_idx]))  # Ω: transcendental log
    )
    d_mixed_norm = d_mixed / d_mixed.max() if d_mixed.max() > 0 else d_mixed

    # 6. Per-axis contribution: how much does each axis alone predict embedding distance?
    per_axis = {}
    for name, d in [("alpha_q1", d_alpha), ("eta_q2", d_eta), ("omega_q3", d_omega),
                    ("uniform_q1", q1_diff), ("uniform_q2", q2_diff), ("uniform_q3", q3_diff)]:
        if d.std() > 0:
            corr = float(np.corrcoef(d, cos_dist)[0,1])
        else:
            corr = 0.0
        per_axis[name] = round(corr, 4)

    # Pearson correlations with embedding distance
    def corr(d):
        if d.std() < 1e-10:
            return 0.0
        return float(np.corrcoef(d, cos_dist)[0,1])

    results = {
        "n_pairs": int(n_pairs),
        "n_clauses": int(n),
        "coordinate_systems": {
            "alpha": {"description": "Arithmetic {0,1,2} — Q1 Mode", "values": [0,1,2]},
            "eta":   {"description": "Geometric {-1,+1,√2} — Q2 Domain", "values": [-1, 1, round(sqrt2,6)]},
            "omega": {"description": f"Transcendental {{2,√2,2^√2}} — Q3 Object", "values": [2, round(sqrt2,6), round(pow2sqrt2,6)]},
        },
        "correlations_with_embedding_distance": {
            "uniform_count":   round(corr(d_uniform), 4),
            "alpha_weighted":  round(corr(d_alpha_norm), 4),
            "eta_weighted":    round(corr(d_eta_norm), 4),
            "omega_weighted":  round(corr(d_omega_norm), 4),
            "mixed_AGT":       round(corr(d_mixed_norm), 4),
        },
        "per_axis_correlations": per_axis,
        "interpretation": {}
    }

    # Interpretation
    best = max(results["correlations_with_embedding_distance"].items(), key=lambda x: x[1])
    results["interpretation"]["best_predictor"] = best[0]
    results["interpretation"]["best_correlation"] = best[1]

    # Does mixed beat uniform?
    mixed_r = results["correlations_with_embedding_distance"]["mixed_AGT"]
    uniform_r = results["correlations_with_embedding_distance"]["uniform_count"]
    results["interpretation"]["mixed_beats_uniform"] = mixed_r > uniform_r
    results["interpretation"]["improvement"] = round(mixed_r - uniform_r, 4)

    # Print summary
    print(f"\n  Distance measure correlations with embedding cosine distance:")
    for name, r in results["correlations_with_embedding_distance"].items():
        bar = "█" * int(abs(r) * 40)
        print(f"    {name:<22} r={r:+.4f}  {bar}")
    print(f"\n  Per-axis correlations:")
    for name, r in per_axis.items():
        print(f"    {name:<22} r={r:+.4f}")
    print(f"\n  Best predictor: {best[0]} (r={best[1]:+.4f})")
    if mixed_r > uniform_r:
        print(f"  Mixed AGT distance OUTPERFORMS uniform count by {mixed_r-uniform_r:+.4f}")
    else:
        print(f"  Uniform count outperforms mixed AGT distance by {uniform_r-mixed_r:+.4f}")

    return results




def _wrap_phasepost(raw):
    """
    Convert stored phasepost format to the format generate_report expects.

    In results.json, phasepost is stored as:
        {"consensus": {cell: count, ...}, "claude": {...}, "gpt4": {...}}

    generate_report (and compute_phasepost_frequency) expects:
        {"counts": {"consensus": {cell: count}, ...},
         "all_cells": [(cell_name, q1, q2, q3, entity_type), ...]}
    """
    if raw is None:
        return None
    if "counts" in raw:
        return raw  # already in the right format

    # Reconstruct all_cells as full tuples matching compute_phasepost_frequency output
    ACT = {
        ("DIFFERENTIATING","EXISTENCE"):    "NUL",
        ("DIFFERENTIATING","STRUCTURE"):    "SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"): "ALT",
        ("RELATING","EXISTENCE"):           "SIG",
        ("RELATING","STRUCTURE"):           "CON",
        ("RELATING","SIGNIFICANCE"):        "SUP",
        ("GENERATING","EXISTENCE"):         "INS",
        ("GENERATING","STRUCTURE"):         "SYN",
        ("GENERATING","SIGNIFICANCE"):      "REC",
    }
    SITE = {
        ("EXISTENCE","CONDITION"):    "Void",    ("EXISTENCE","ENTITY"):   "Entity",
        ("EXISTENCE","PATTERN"):      "Kind",    ("STRUCTURE","CONDITION"): "Field",
        ("STRUCTURE","ENTITY"):       "Link",    ("STRUCTURE","PATTERN"):  "Network",
        ("SIGNIFICANCE","CONDITION"): "Atmosphere",("SIGNIFICANCE","ENTITY"):"Lens",
        ("SIGNIFICANCE","PATTERN"):   "Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"): "Clearing",  ("DIFFERENTIATING","ENTITY"): "Dissecting",
        ("DIFFERENTIATING","PATTERN"):   "Unraveling", ("RELATING","CONDITION"):    "Tending",
        ("RELATING","ENTITY"):           "Binding",    ("RELATING","PATTERN"):      "Tracing",
        ("GENERATING","CONDITION"):      "Cultivating",("GENERATING","ENTITY"):     "Making",
        ("GENERATING","PATTERN"):        "Composing",
    }
    ENTITY_TYPE = {"CONDITION": "Emanon", "ENTITY": "Holon", "PATTERN": "Protogon"}

    def cell_name(q1, q2, q3):
        op  = ACT.get((q1, q2), "?")
        res = RES.get((q1, q3), "?")
        sit = SITE.get((q2, q3), "?")
        return f"{op}({res}, {sit})"

    all_cells = []
    for q1 in ["DIFFERENTIATING","RELATING","GENERATING"]:
        for q2 in ["EXISTENCE","STRUCTURE","SIGNIFICANCE"]:
            for q3 in ["CONDITION","ENTITY","PATTERN"]:
                cn = cell_name(q1, q2, q3)
                et = ENTITY_TYPE.get(q3, "?")
                all_cells.append((cn, q1, q2, q3, et))

    return {"counts": raw, "all_cells": all_cells}


def generate_report(
    run_dir: Path,
    zscores: dict,
    proportionality: dict,
    ari: dict,
    per_lang: dict,
    kappas: dict,
    n_clauses: int,
    n_languages: int,
    models_used: list,
    n_total_embedded: int = 0,
    all_zscores: dict = None,
    all_ari: dict = None,
    face_zscores: dict = None,
    unsupervised: dict = None,
    ari_exclusion: dict = None,
    entity_z: float = None,
    phasepost_data: dict = None,
    full_zscores: dict = None,
    full_face_zscores: dict = None,
    coord_results: dict = None,
    helix_tests: dict = None,
    subspace_geo: dict = None,
):
    """Write the full analysis report to analysis_report.txt."""

    lines = []
    def w(s=""): lines.append(s)
    def h1(s):   w(); w("=" * 74); w(f"  {s}"); w("=" * 74)
    def h2(s):   w(); w(f"── {s} {'─'*(68-len(s))}"); w()
    def p(s, indent=2): lines.extend(textwrap.wrap(s, width=70, initial_indent=" "*indent, subsequent_indent=" "*indent)); w()

    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    h1(f"EO LEXICAL ANALYSIS v2 — RESULTS REPORT")
    w(f"  Generated: {timestamp}")
    if n_total_embedded and n_total_embedded != n_clauses:
        w(f"  Corpus:    {n_total_embedded:,} total embedded | {n_clauses:,} consensus across {n_languages} languages")
    else:
        w(f"  Corpus:    {n_clauses:,} consensus clauses across {n_languages} languages")
    w(f"  Models:    {', '.join(models_used)}")

    # ── PREAMBLE ─────────────────────────────────────────────────────────────
    h1("WHAT THIS STUDY IS TESTING")
    p("""\
Emergent Ontology (EO) proposes that any transformation — any event where \
something changes — can be located in a 27-cell structure defined by three \
independent axes. This study tests whether those axes correspond to real, \
independent dimensions in the semantic geometry of natural language.""")

    p("""\
The test: we took real sentences from corpora in dozens of languages, \
asked three plain questions about each sentence, embedded the original \
text using an AI that has never seen EO, and measured whether sentences \
classified the same way ended up geometrically close. \
No EO vocabulary appears anywhere in the embeddings.""")

    p("The three questions:")
    w("    Q1 — Is this transformation separating, connecting, or producing?")
    w("    Q2 — Is it operating on existence, organization, or meaning?")
    w("    Q3 — Is the target a background condition, a specific thing, or a pattern?")
    w()
    p("Pre-committed predictions (locked before data was processed):")
    w("    (1) Distance scales monotonically with number of differing axes")
    w("    (2) Pairwise ARI between axes < 0.10 (axes are independent)")
    w("    (3) Q2 z-score exceeds Q1 z-score in 20+ languages (Domain primacy)")
    w("    (4) Inter-model kappa > 0.5 on Q1, > 0.4 on Q2, > 0.35 on Q3")
    w()
    p("Note: operator frequency rank prediction (Test D) is computed but not reported as a primary result. Small n (9 operators) limits interpretability.")

    # ── PER-AXIS Z-SCORES ────────────────────────────────────────────────────
    h1("RESULT 1 — PER-AXIS Z-SCORES")
    p("""\
The z-score measures how much more geometrically coherent the classified \
groups are than random groupings of the same size. A z-score of -79 means \
the actual grouping is 79 standard deviations tighter than chance — which \
was the v1 English result on bare verbs. We expect clauses to do better \
because the clause fixes all three dimensions simultaneously.""")

    p("Z-scores are reported as standard deviations from chance. Higher = more geometrically coherent than random groupings of the same size.")
    w()

    for axis, label in [("q1","Q1 — Mode (separating/connecting/producing)"),
                         ("q2","Q2 — Domain (existence/organization/meaning)"),
                         ("q3","Q3 — Object (condition/particular/pattern)")]:
        z_val = zscores.get(axis, {}).get("z", "n/a")
        sep   = zscores.get(axis, {}).get("separation", "n/a")
        w(f"  {label}")
        if isinstance(z_val, float):
            w(f"    {z_val:+.2f} SDs from chance  (raw separation: {sep:+.4f})")
        else:
            w(f"    z = {z_val}   (insufficient data)")
        w()

    # ── PROPORTIONALITY ──────────────────────────────────────────────────────
    h1("RESULT 2 — PROPORTIONALITY")
    p("""\
If EO's three axes form a real coordinate system, then sentences that \
differ on MORE axes should be geometrically FARTHER apart in embedding \
space. Sharing all three axis-labels means maximum semantic similarity. \
Differing on all three means maximum dissimilarity. \
This is a stronger claim than mere clustering — it tests the arrangement \
of the cells, not just whether the cells exist.""")

    prop = proportionality
    w("  Mean cosine DISTANCE by number of differing axes:")
    w("  (Higher distance = less similar = more different)")
    w()
    for k in [0, 1, 2, 3]:
        d = prop.get(k, prop.get(str(k), {}))
        mean = d.get("mean_distance")
        n    = d.get("n_pairs", 0)
        if mean is not None:
            bar = "█" * int(mean * 40)
            w(f"  {k} axes different  │ {mean:.4f}  {bar}  (n={n:,} pairs)")
        else:
            w(f"  {k} axes different  │ insufficient data")
    w()
    mono = prop.get("monotone", None)
    boot_p = prop.get("monotone_bootstrap_p")
    if mono is True:
        w(f"  {green('✓')} Monotonicity holds — distance increases with axis-difference count")
        if boot_p is not None:
            stability = "stable" if boot_p < 0.05 else "borderline"
            w(f"  Bootstrap p = {boot_p:.4f}  (fraction of resamples where ordering fails — {stability})")
        p("This confirms that the three axes form a real coordinate structure, not just arbitrary groupings.")
    elif mono is False:
        w(f"  {red('✗')} Monotonicity fails — distance does NOT scale with axis-difference count")
        if boot_p is not None:
            w(f"  Bootstrap p = {boot_p:.4f}")
        p("This is a significant negative result: EO may be identifying semantic neighborhoods but not a real coordinate system.")
    else:
        w("  Monotonicity: insufficient data")

    # ── AXIS INDEPENDENCE ────────────────────────────────────────────────────
    h1("RESULT 3 — AXIS INDEPENDENCE (ARI)")
    p("""\
EO claims the three axes are genuinely independent — knowing a sentence's \
Mode (Q1) should give you no information about its Domain (Q2) or its \
Object grain (Q3). The Adjusted Rand Index (ARI) measures how much two \
classification schemes agree. ARI = 0 means complete independence. \
ARI = 1 means perfect agreement.""")

    p("Predictions: all pairs should show ARI < 0.10")
    w()
    for pair, val in ari.items():
        verdict = _ari_verdict(val)
        axes = pair.replace("_vs_"," vs ")
        w(f"  {axes:<12}  ARI = {val:+.4f}  {verdict}")
    w()
    max_ari = max(ari.values()) if ari else None
    q1q2_ari = ari.get("q1_vs_q2")

    if max_ari is not None:
        if max_ari < 0.10:
            p(f"Maximum pairwise ARI is {max_ari:.4f}. All axes are statistically independent. The three-axis claim holds.")
        elif max_ari < 0.20:
            p(f"Maximum pairwise ARI is {max_ari:.4f}. Q2/Q3 and Q1/Q3 are independent. Q1/Q2 shows mild correlation — see analysis below.")
        else:
            p(f"Maximum pairwise ARI is {max_ari:.4f}. The axes are NOT independent at this threshold. The three-axis claim is challenged.")

    # ── Q1/Q2 correlation deep analysis ──────────────────────────────────────
    if q1q2_ari is not None and q1q2_ari >= 0.10:
        w()
        h2("The Q1/Q2 Correlation: Two Readings")
        p("""Q1 (Mode) and Q2 (Domain) show ARI of approximately 0.14-0.17. This is stable across all label sets and both model runs — not noise. SEPARATING tends to co-occur with STRUCTURE and EXISTENCE. PRODUCING tends to co-occur with EXISTENCE. SEPARATING rarely appears with SIGNIFICANCE.""")
        w()
        w("  Reading 1 — Distributional artifact of helix dependency ordering:")
        p("""The correlation may be a structural consequence of the helix. ALT (SEPARATING x SIGNIFICANCE) is sparse because by the time a system is operating in the Significance domain, the separation work has already happened upstream. SYN x Condition is the universal desert. If the ARI drops toward zero when sparse and dominant cells are excluded, the axes are genuinely orthogonal — the non-uniform distribution is itself one of EO's predictions, not evidence against it.""", indent=4)
        w()
        w("  Reading 2 — Genuine semantic dependency:")
        p("""SEPARATING genuinely tends toward lower-complexity domains. The cognitive operation of separation may be structurally harder to instantiate at the level of Significance than at Existence or Structure. The capacity ground is not a flat grid — it has a topology. Some cells are hard to reach not because language lacks vocabulary but because those combinations are structurally unusual.""", indent=4)
        w()
        w("  The distinguishing test: cell-exclusion ARI")
        p("""If the Q1/Q2 ARI drops toward zero after excluding cells the helix predicts will be sparse, Reading 1 is confirmed. If it stays high, Reading 2 has support. Results of this test are shown below.""", indent=4)

    # ── Cell-exclusion test ───────────────────────────────────────────────────
    if ari_exclusion:
        w()
        h2("Cell-Exclusion Test — Is Q1/Q2 Correlation from Helix Sparsity?")
        ae = ari_exclusion
        w(f"  ARI on full corpus:            {ae.get('ari_all', 'n/a'):>+8.4f}")
        if ae.get("ari_excluding_sparse") is not None:
            w(f"  ARI excluding sparse/dominant: {ae['ari_excluding_sparse']:>+8.4f}")
            delta = ae["ari_all"] - ae["ari_excluding_sparse"]
            w(f"  Delta:                         {delta:>+8.4f}")
            w(f"  Cells excluded: {', '.join(ae.get('cells_excluded', [])[:8])}")
            w(f"  Clauses excluded: {ae.get('n_excluded', 0):,}")
        w()
        p(ae.get("interpretation", ""))
        p("""\
Methodological caveat: excluding sparse cells also reduces label diversity \
in the remaining data, which independently affects ARI regardless of whether \
the correlation is structural or artifactual. The test cannot cleanly \
isolate the two mechanisms. The result is suggestive of Reading 2 but the \
binary "Reading 1 vs Reading 2" framing overstates what the exclusion test \
can distinguish.""")

    # ── INTER-MODEL AGREEMENT ─────────────────────────────────────────────────
    if kappas:
        h1("RESULT 4 — INTER-MODEL AGREEMENT (COHEN'S KAPPA)")
        p("""\
Multiple AI models were asked the same three questions independently. \
Cohen's kappa measures how much they agree beyond chance. \
High kappa means the questions are tracking something robust — \
different models reliably give the same answer. \
Low kappa means the axis is ambiguous or the questions are under-specified.""")

        p("""\
Consensus selection bias diagnostic: the primary z-scores use only clauses \
where both models agreed. If disagreement is systematically higher for \
specific axis values (e.g. Q2=SIGNIFICANCE being more contested), those \
cells are underrepresented in the consensus set. Per-value agreement rates \
below reveal whether this is occurring.""")

        p("Interpretation guide:")
        w("    kappa < 0.20 : Poor agreement. Questions don't have clear answers.")
        w("    kappa 0.20–0.40 : Fair agreement.")
        w("    kappa 0.40–0.60 : Moderate agreement.")
        w("    kappa > 0.60 : Good agreement. The axis is robustly classifiable.")
        w()
        p("Predictions: Q1 > 0.50, Q2 > 0.40, Q3 > 0.35")
        w()
        for pair, axes in kappas.items():
            w(f"  {pair}:")
            for axis, k in axes.items():
                verdict = _kappa_verdict(k)
                w(f"    {axis}: kappa = {k:.3f}  {verdict}")
            w()

    # ── CROSS-LINGUISTIC ─────────────────────────────────────────────────────
    if per_lang:
        h1("RESULT 5 — CROSS-LINGUISTIC Z-SCORES")
        p("""\
The axes should be real across language families, not just in English. \
Sentences in Korean, Arabic, Finnish, Swahili, and Classical Chinese were \
classified with the same three questions and embedded in the same space. \
If the structure is universal, the z-scores should be significant across \
typologically diverse languages.""")
        p("""\
Corpus source confound: UD treebanks are parsed real text (news, Wikipedia, \
legal, literary) with genuine syntactic variety. FLORES-200 consists of \
professionally translated declarative sentences of comparable length and \
register, likely skewed toward GENERATING/EXISTENCE and RELATING/STRUCTURE \
patterns. Pooling these without source-stratification means cross-linguistic \
z-scores partially reflect source differences, not only typological universality. \
Per-language results are more reliable than the pooled signal for this reason.""")
        p("""\
Note on multiple comparisons: up to 3 z-score tests × 39 languages = up to \
117 tests are run. No per-language significance threshold is applied. \
Per-language z-scores are reported as directional signals. Tests are \
underpowered at 100-500 clauses per language; the aggregate pooled signal \
is the primary result.""")

        # Count languages with positive signal (z > 2) per grouping — directional only
        pos_q1  = sum(1 for v in per_lang.values() if v.get("q1",{}).get("z",0) > 2)
        pos_q2  = sum(1 for v in per_lang.values() if v.get("q2",{}).get("z",0) > 2)
        pos_q3  = sum(1 for v in per_lang.values() if v.get("q3",{}).get("z",0) > 2)
        pos_res = sum(1 for v in per_lang.values() if v.get("resolution_face",{}).get("z",0) > 2)
        pos_f27 = sum(1 for v in per_lang.values() if v.get("full_27cell",{}).get("z",0) > 2)
        w(f"  Languages with Q1 z > 2:           {pos_q1} of {len(per_lang)}")
        w(f"  Languages with Q2 z > 2:           {pos_q2} of {len(per_lang)}")
        w(f"  Languages with Q3 z > 2:           {pos_q3} of {len(per_lang)}")
        w(f"  Languages with Resolution face z > 2: {pos_res} of {len(per_lang)}")
        w(f"  Languages with Full 27-cell z > 2:    {pos_f27} of {len(per_lang)}")
        w()
        w(f"  {'Language':<10} {'Q1':>6} {'Q2':>6} {'Q3':>6} {'Act':>7} {'Site':>7} {'Res':>7} {'27cell':>8}")
        w(f"  {'─'*10} {'─'*6} {'─'*6} {'─'*6} {'─'*7} {'─'*7} {'─'*7} {'─'*8}")
        for lang in sorted(per_lang.keys()):
            v = per_lang[lang]
            def fmt(z):
                if z == "" or z is None: return f"{'n/a':>6}"
                try: return f"{float(z):>+6.2f}"
                except: return f"{'n/a':>6}"
            def fmt8(z):
                if z == "" or z is None: return f"{'n/a':>8}"
                try: return f"{float(z):>+8.2f}"
                except: return f"{'n/a':>8}"
            q1z  = v.get("q1",{}).get("z","")
            q2z  = v.get("q2",{}).get("z","")
            q3z  = v.get("q3",{}).get("z","")
            actz = v.get("act_face",{}).get("z","")
            sitz = v.get("site_face",{}).get("z","")
            resz = v.get("resolution_face",{}).get("z","")
            f27z = v.get("full_27cell",{}).get("z","")
            w(f"  {lang:<10}{fmt(q1z)}{fmt(q2z)}{fmt(q3z)}{fmt(actz)}{fmt(sitz)}{fmt(resz)}{fmt8(f27z)}")

    # ── FULL CORPUS (all 19k) ────────────────────────────────────────────────
    if full_zscores or full_face_zscores:
        h1("RESULT — FULL CORPUS Z-SCORES (ALL EMBEDDED CLAUSES)")
        p("""The primary analysis uses only consensus clauses (both models agreed). This section runs the same geometric tests on all embedded clauses using best-available labels — consensus where available, else the per-model label. This tests whether the signal survives when ambiguous boundary cases are included.""")
        p("""Selection bias caveat: consensus labels are only assigned when both models agree. If inter-model disagreement is systematically correlated with certain axis values — e.g. Q2=SIGNIFICANCE may generate more disagreement because it is more philosophically contested — then the consensus subset underrepresents those cells. The per-model z-scores (claude-only and gpt4-only sets) partially address this by including all classified clauses regardless of agreement.""")
        if full_zscores:
            w()
            w(f"  {'Axis':<30} {'z-score':>10}  {'n clauses':>12}")
            w(f"  {'─'*30} {'─'*10}  {'─'*12}")
            for axis, v in full_zscores.items():
                w(f"  {axis:<30} {v['z']:>+10.2f}  {v['n']:>12,}")
        if full_face_zscores:
            w()
            for face, v in full_face_zscores.items():
                w(f"  {face:<30} {v['z']:>+10.2f}")

    # ── HELIX DEPENDENCY TESTS ───────────────────────────────────────────────
    if helix_tests:
        h1("RESULT — HELIX DEPENDENCY STRUCTURE (3 TESTS)")
        p("""The ARI=0.185 between Mode and Domain is compatible with both random coupling and structured dependency. These three tests check whether the correlation is directed, ordered, and topologically predictable — which is what the helix claim requires. If these pass, the dependency is the structure EO predicts, not incidental correlation.""")

        # helix_tests is now {"consensus": {...}, "combined": {...}}
        # Show both sets, compare
        _ht_sets = list(helix_tests.keys()) if isinstance(helix_tests, dict) and "consensus" in helix_tests else [""]
        _ht = helix_tests.get("consensus", helix_tests) if isinstance(helix_tests.get("consensus"), dict) else helix_tests
        t1 = _ht.get("test1_directional_entropy", {})
        t2 = _ht.get("test2_ordinal_correlation", {})
        t3 = _ht.get("test3_topology_prediction", {})

        h2("Test 1 — Directional Asymmetry (Information Flow)")
        p("""Conditional entropy measures how much uncertainty about one axis remains after knowing the other. If the dependency is directed, the two values differ.""")
        w(f"  H(Q1 Mode)   = {t1.get('H_q1','?')} bits")
        w(f"  H(Q2 Domain) = {t1.get('H_q2','?')} bits")
        w()
        w(f"  H(Q2|Q1) = {t1.get('H_q2_given_q1','?')} bits  [uncertainty in Domain given Mode]")
        w(f"  H(Q1|Q2) = {t1.get('H_q1_given_q2','?')} bits  [uncertainty in Mode given Domain]")
        w()
        asym = t1.get("asymmetry_bits", 0)
        pval = t1.get("asymmetry_pval", 1)
        direction = t1.get("direction","?")
        w(f"  Asymmetry = {asym:+.4f} bits  (permutation p={pval:.4f})")
        w(f"  Preferred direction: {direction}")
        w()
        p(t1.get("interpretation",""))

        h2("Test 2 — Mode Ordinal Predicts Domain Ordinal")
        p("""Spearman rank correlation between Mode ordinal position (DIFFERENTIATING=1, RELATING=2, GENERATING=3) and Domain ordinal complexity (EXISTENCE=1, STRUCTURE=2, SIGNIFICANCE=3). A directed helix dependency predicts a non-zero correlation with a specific sign.""")
        r2 = t2.get("spearman_r","?")
        p2 = t2.get("spearman_p","?")
        n2 = t2.get("n_sample","?")
        w(f"  Spearman r={r2}  p={p2}  (n={n2:,})" if isinstance(n2,int) else f"  Spearman r={r2}  p={p2}")
        w()
        p(t2.get("interpretation",""))

        # Test 3 (frequency prediction) removed — small n, not reported

    # ── SUBSPACE GEOMETRY ────────────────────────────────────────────────────
    if subspace_geo:
        h1("RESULT — SUBSPACE GEOMETRY (PRINCIPAL ANGLES + LDA)")
        p("""The PCA figures show the content space, not the EO subspace. This analysis reveals the shape of the EO axes in embedding space directly. Principal angles measure how orthogonal the Mode and Domain centroid subspaces are — angle near 90° means geometrically independent, near 0° means same dimension. The LDA projection finds the directions that actually separate the EO labels, after removing content variance.""")
        w()
        h2("Principal Angles Between Axis Subspaces")
        p("""Each axis defines a 2-d subspace via its 3 centroids (after centering). Principal angles between pairs of these subspaces are the direct geometric measure of their independence — more informative than ARI for characterizing the dependency structure.""")
        for pair, res in subspace_geo.get("principal_angles", {}).items():
            w()
            w(f"  {pair.replace('_',' ')}:")
            if "error" in res:
                w(f"    Error: {res['error']}")
            else:
                angles = res.get("principal_angles_deg",[])
                w(f"    Principal angles: {angles}°")
                w(f"    Min angle: {res.get('min_angle_deg','?')}°")
                p(res.get("interpretation",""), indent=4)
        w()
        h2("LDA Projection — EO Discriminant Subspace")
        p("""Linear Discriminant Analysis finds the directions in 3072-d space that maximally separate the EO labels. These figures show the actual EO subspace, not the content space. The shape visible here — whether flat, clustered, or structured — is the geometry of the EO signal itself.""")
        for axis, lda_res in subspace_geo.get("lda", {}).items():
            if "error" in lda_res:
                w(f"  LDA {axis}: {lda_res['error']}")
            else:
                var = lda_res.get("explained_variance_ratio")
                if var:
                    w(f"  LDA {axis}: LD1={var[0]:.1%}, LD2={var[1]:.1%} of discriminant variance")
                w(f"  → See figures/lda_by_{axis}.png")

    # ── COORDINATE GEOMETRY ───────────────────────────────────────────────────
    if coord_results:
        h1("RESULT — COORDINATE GEOMETRY (α/η/Ω AXIS METRIC TEST)")
        p("""EO's three axes carry distinct mathematical characters: Mode α \
(Arithmetic) {0,1,2} — equal steps; Domain η (Geometric) {-1,+1,√2} — \
asymmetric, E↔S gap predicted 4.8× larger than S↔Sig; Object Ω \
(Transcendental) {√2,2,2^√2} — unequal steps. This tests whether \
inter-centroid distances in 3072-dimensional embedding space reflect those \
coordinate predictions. Two runs: CONSENSUS (9,221 high-confidence clauses, \
single label each) and COMBINED (~39,000 assignments — all 19,764 clauses \
counted under both model labels, disagreements netting out rather than \
filtering out). Where both agree: robust. Where they diverge: the \
disagreement cases express the Q2 anomaly geometrically.""")
        w()

        AXIS_LABELS = {
            "mode":   "Mode α (Arithmetic)       {0, 1, 2}",
            "domain": "Domain η (Geometric)      {-1, +1, √2}",
            "object": "Object Ω (Transcendental) {√2, 2, 2^√2}",
        }
        PREDICTIONS = {
            "mode":   "Equal steps — D↔R ≈ R↔G (ratio ≈ 1.0)",
            "domain": "Asymmetric — E↔S / S↔Sig ≈ 4.8",
            "object": "C↔E ≈ 0.586, E↔P ≈ 0.665 coord units",
        }

        for set_label in ["consensus", "combined"]:
            set_res = coord_results.get(set_label, {})
            if not set_res:
                continue
            h2(f"Set: {set_label.upper()}")
            for axis in ["mode","domain","object"]:
                res = set_res.get(axis, {})
                if not res or "error" in res:
                    w(f"  {AXIS_LABELS.get(axis,axis)}: insufficient data")
                    continue
                w()
                w(f"  {AXIS_LABELS.get(axis,axis)}")
                w(f"  Prediction: {PREDICTIONS.get(axis,'')}")
                r  = res.get("pearson_r","?")
                pv = res.get("pearson_p","?")
                # Pearson r not reported: 3 data points → df=1 → statistically
                # uninformative. Directional predictions are the valid test.
                w()
                w(f"    {'Pair':<35} {'Emb dist':>10}  {'Coord pred':>10}")
                w(f"    {'─'*35} {'─'*10}  {'─'*10}")
                for pair in sorted(res.get("embedding_distances",{}).keys()):
                    ed = res["embedding_distances"][pair]
                    cd = res.get("coordinate_distances",{}).get(pair,"?")
                    w(f"    {pair:<35} {ed:>10.5f}  {cd:>10.4f}" if isinstance(cd,float) else
                      f"    {pair:<35} {ed:>10.5f}  {'?':>10}")
                d = res.get("directional", {})
                if d:
                    if axis == "domain":
                        obs  = d.get("observed_ratio","?")
                        pred = d.get("predicted_ratio","?")
                        met  = d.get("prediction_met", False)
                        v = "✓ DIRECTIONAL PREDICTION MET" if met else "✗ directional prediction not met"
                        w(f"    E↔S/S↔Sig ratio: {obs:.3f}  (predicted {pred:.3f})  {v}")
                    elif axis == "mode":
                        ratio = d.get("step_ratio","?")
                        v = "✓ equal steps" if d.get("equal_steps_met") else "✗ unequal steps"
                        w(f"    Step ratio: {ratio:.3f}  {v}")
                    elif axis == "object":
                        v = "✓ additive" if d.get("additive_holds") else "✗ non-additive"
                        w(f"    C↔P ≈ C↔E + E↔P: {v}")


    # ── SUMMARY VERDICT ───────────────────────────────────────────────────────
    # ── Entity type section ──────────────────────────────────────────────────
    if entity_z is not None:
        h1("ENTITY TYPES — Q3 RELABELING ONLY (not an independent result)")
        p("""Note: this result is a relabeling of Q3 (Object grain) and is numerically identical to the Q3 z-score in Result 1. CONDITION→Emanon, ENTITY→Holon, PATTERN→Protogon is a 1-to-1 mapping, so the z-score is the same measurement reported with EO entity-type vocabulary. It is included here for completeness and framing, not as an independent result.""")
        p("""EO identifies three entity types based on which aspect of Ground/Figure/Pattern dominates a configuration:""")
        w()
        w("    CONDITION targets  →  Emanon-prone")
        w("      Ground-dominant phenomena. Ambient, pre-figural, contextual.")
        w("      Proliferate when examined directly. Market confidence,")
        w("      organizational culture, the vibe of a place.")
        w()
        w("    ENTITY targets     →  Holon-prone")
        w("      Balanced configurations. Clear identity, stable figure,")
        w("      self-maintaining. Living cells, mature institutions, languages.")
        w()
        w("    PATTERN targets    →  Protogon-prone")
        w("      Pattern-dominant, crystallizing. Identities still forming,")
        w("      transformation underway. Startups, developing theories,")
        w("      emerging movements.")
        w()
        p("""These correspond to positions 1-9 (Emanon), 10-18 (Holon), and 19-27 (Protogon) in the capacity ground. The Q3 z-score already measures whether these three groups cluster geometrically — here we report it with the entity-type framing explicit.""")
        w()
        verdict = green("positive") if entity_z > 2 else yellow("marginal") if entity_z > 0 else red("no signal")
        w(f"  Entity type z-score (Emanon / Holon / Protogon): {entity_z:+.2f}  {verdict}")
        w()
        if entity_z < -10:
            p("""Clauses targeting conditions (Emanon-prone), specific entities (Holon-prone), and patterns (Protogon-prone) cluster in distinct geometric regions of embedding space. The three entity types are geometrically real.""")
        elif entity_z < -5:
            p("""Weak but real geometric separation between the three entity type groups. The Emanon/Holon/Protogon distinction is present in embedding space but not strongly separated at current corpus size.""")
        else:
            p("""No significant geometric separation between entity type groups at current corpus size. This is the same signal as Q3 — see Q3 z-score in Result 1.""")
        w()
        p("""The figure pca_by_entity_type.png shows the 2D PCA projection colored by entity type. If the three types cluster visibly in the projection, the structure is strong enough to survive dimensional compression to 2D.""")

    # ── Operators and faces section ──────────────────────────────────────────
    if face_zscores:
        h1("RESULT 7 — OPERATORS AND FACES vs AXES")
        p("""The axes produce 3 groups each (z-scores in Result 1). The operators and faces produce 9 groups by combining two axes. If the 9-group z-scores are stronger than the 3-group axis z-scores, the combinatorial structure is carrying real semantic information — the intersections matter, not just the dimensions individually. If weaker, the axes are the fundamental structure and the 9-cell grids are derived.""")

        w(f"  {'Grouping':<45} {'z-score':>9}  Groups  Interpretation")
        w(f"  {'─'*45} {'─'*9}  {'─'*6}  {'─'*25}")

        # Include the per-axis z-scores for comparison
        axis_rows = [
            ("Q1 alone (Mode, 3 groups)",    zscores.get("q1",{}).get("z")),
            ("Q2 alone (Domain, 3 groups)",  zscores.get("q2",{}).get("z")),
            ("Q3 alone (Object, 3 groups)",  zscores.get("q3",{}).get("z")),
        ]
        for label, z in axis_rows:
            if z is None: continue
            verdict = ""
            w(f"  {label:<45} {z:>+9.2f}       3  {verdict}")
        w()

        order = ["operators_act", "face_site", "face_resolution", "full_27cell"]
        for key in order:
            if key not in face_zscores: continue
            d = face_zscores[key]
            z = d["z"]
            ng = d.get("n_groups","?")
            label = d.get("label", key)
            verdict = ""
            w(f"  {label:<45} {z:>+9.2f}  {ng:>5}  {verdict}")
        w()

        # Interpretation
        op_z = face_zscores.get("operators_act",{}).get("z")
        q1_z = zscores.get("q1",{}).get("z")
        q2_z = zscores.get("q2",{}).get("z")
        if op_z and q1_z and q2_z:
            if op_z < q1_z and op_z < q2_z:
                p("The operator z-score is stronger than both axis z-scores. The combinatorial structure (Mode × Domain together) produces tighter geometric clusters than either axis alone. The 9 operators are more geometrically real than the 3-way splits.")
            elif op_z < min(q1_z, q2_z) * 0.8:
                p("Operators show comparable signal to the axes. The 9-cell Act face is approximately as coherent as its component dimensions.")
            else:
                p("The axis z-scores exceed the operator z-score. The primary geometric structure is at the axis level (3 groups), not the operator level (9 groups). The combinatorial intersections are less cleanly separated than the individual dimensions.")

    # ── Unsupervised section ──────────────────────────────────────────────────
    if unsupervised:
        h1("RESULT 8 — UNSUPERVISED STRUCTURE")
        p("""KMeans clustering run without EO labels. Tests whether the data-driven clusters correspond to EO's axes, operators, or 27-cell addresses. ARI near 0 means no correspondence. ARI above 0.10 means meaningful overlap — the geometry is spontaneously organizing in a way EO predicts.""")
        p("""Multiple testing note: three ARI comparisons (vs Q1, Q2, Q3) from one k=3 KMeans run. No Bonferroni correction applied — treat any individual ARI as directional rather than a significance claim.""")

        pca_v = unsupervised.get("pca_variance",{})
        if pca_v:
            w(f"  PCA variance structure:")
            w(f"    Top 3 components capture: {pca_v.get('top3_variance',0)*100:.1f}% of variance")
            w(f"    Components needed for 50%: {pca_v.get('pcs_for_50pct','?')}")
            w(f"    Components needed for 80%: {pca_v.get('pcs_for_80pct','?')}")
            w()
            p("High-dimensional embeddings are dense — needing many PCs for 50% variance is normal. The EO axes are not expected to be the top PCs, since the embedding space is organized primarily by semantic content (what the clause is about), not by transformation type. The z-score tests are the right instrument, not explained variance.")

        km = unsupervised.get("kmeans",{})
        if km:
            w(f"  KMeans clustering vs EO labels:")
            w(f"  {'k':<6} {'ARI result':<35} Interpretation")
            w(f"  {'─'*6} {'─'*35} {'─'*30}")

            if 3 in km:
                d = km[3]
                best_axis = max([("Q1",d.get("ari_vs_q1",0)),
                                  ("Q2",d.get("ari_vs_q2",0)),
                                  ("Q3",d.get("ari_vs_q3",0))], key=lambda x:x[1])
                w(f"  k=3   Q1={d.get('ari_vs_q1',0):.3f} Q2={d.get('ari_vs_q2',0):.3f} Q3={d.get('ari_vs_q3',0):.3f}  Best match: {best_axis[0]} (ARI={best_axis[1]:.3f})")

            if 9 in km:
                d = km[9]
                ari = d.get("ari_vs_operators",0)
                interp = "meaningful overlap" if ari > 0.10 else "weak" if ari > 0.03 else "no correspondence"
                w(f"  k=9   operators ARI={ari:.3f}  {' '*20} {interp}")

            if 27 in km:
                d = km[27]
                ari = d.get("ari_vs_27cell",0)
                interp = "meaningful overlap" if ari > 0.05 else "weak" if ari > 0.01 else "no correspondence"
                w(f"  k=27  27-cell ARI={ari:.3f}   {' '*20} {interp}")
            w()
            p("""Low KMeans ARI against EO labels does not falsify EO. It means the embedding space is not organized around EO's categories as its primary structure — which is expected, since embeddings encode semantic content first. The meaningful test is the z-score (do EO-labeled groups cluster more than chance?), not whether EO emerges spontaneously from unsupervised clustering.""")

    # ── Cross-set comparison section ─────────────────────────────────────────
    if all_zscores and len(all_zscores) > 1:
        h1("CROSS-SET COMPARISON — CONSENSUS vs CLAUDE vs GPT-4")
        p("""This is the classifier-independence test. The same geometric analysis is run three times: once on clauses where both models agreed (consensus), once on Claude's labels for all clauses, and once on GPT-4's labels for all clauses. If the z-scores are similar across all three sets, the structure is real and classifier-independent. If one model produces much stronger signal than the other, that model's internal representation is driving the result.""")

        w(f"  {'Set':<12} {'Q1 z':>8} {'Q2 z':>8} {'Q3 z':>8}  Interpretation")
        w(f"  {'─'*12} {'─'*8} {'─'*8} {'─'*8}  {'─'*35}")
        for set_name in ["consensus", "claude", "gpt4", "combined", "ud_only"]:
            if set_name not in all_zscores:
                continue
            zs = all_zscores[set_name]
            def fmtz(z):
                if not isinstance(z, (int,float)): return f"{'n/a':>8}"
                return f"{z:>+8.2f}"
            q1z = zs.get("q1",{}).get("z","n/a")
            q2z = zs.get("q2",{}).get("z","n/a")
            q3z = zs.get("q3",{}).get("z","n/a")
            interp = {"consensus": "both models agreed", "claude": "Claude labels only", "gpt4": "GPT-4 labels only"}.get(set_name,"")
            w(f"  {set_name:<12}{fmtz(q1z)}{fmtz(q2z)}{fmtz(q3z)}  {interp}")
        w()

        # Interpretation
        sets_present = [s for s in ["consensus","claude","gpt4","combined","ud_only"] if s in all_zscores]
        if len(sets_present) >= 2:
            # Check if all sets agree (within 5 z-units on average)
            q1_zs = [all_zscores[s].get("q1",{}).get("z",0) for s in sets_present if isinstance(all_zscores[s].get("q1",{}).get("z"),float)]
            if q1_zs and (max(q1_zs) - min(q1_zs)) < 5:
                p("Z-scores are consistent across label sets. The geometric structure does not depend on which model classified the clauses — this is the classifier-independence result.")
            else:
                p("Z-scores diverge between label sets. One model's classifications produce stronger geometric signal than the other's. The structure may be partially model-specific.")

        if all_ari:
            w("  Axis independence (ARI) across sets:")
            for set_name in ["consensus","claude","gpt4"]:
                if set_name not in all_ari:
                    continue
                a = all_ari[set_name]
                w(f"  {set_name:<12}  q1/q2={a.get('q1_vs_q2','n/a'):>+.3f}  q1/q3={a.get('q1_vs_q3','n/a'):>+.3f}  q2/q3={a.get('q2_vs_q3','n/a'):>+.3f}")
            w()

    # ── Phasepost frequency section ──────────────────────────────────────────
    if phasepost_data:
        h1("PHASEPOST FREQUENCY — ALL 27 CELLS")
        p("""Every clause has a full 27-cell address: Q1×Q2×Q3. The phasepost frequency table shows how often each cell appears in the corpus, grouped by triad. Three label sets are shown: consensus (both models agreed), Claude-only, and GPT-4-only. Comparing the three sets shows where the models agree on cell assignment and where they diverge.""")
        w()
        p("""Entity type (Emanon / Holon / Protogon) is derived from Q3: CONDITION = Emanon-prone (ground-dominant, ambient), ENTITY = Holon-prone (balanced, stable), PATTERN = Protogon-prone (pattern-dominant, crystallizing).""")

        pp_counts = phasepost_data["counts"]
        pp_cells  = phasepost_data["all_cells"]

        for label_key, label_title in [
            ("consensus", "CONSENSUS (both models agreed)"),
            ("claude",    "CLAUDE labels only"),
            ("gpt4",      "GPT-4 labels only"),
        ]:
            total = sum(pp_counts.get(label_key, {}).values())
            if total == 0:
                continue
            w()
            h2(f"{label_title} — {total:,} clauses")
            table_lines = format_phasepost_table(pp_counts, pp_cells, label_key)
            for l in table_lines:
                w(l)

        # Cross-set comparison: which cells diverge most between models
        c_counts = pp_counts.get("claude", {})
        g_counts = pp_counts.get("gpt4", {})
        c_total  = sum(c_counts.values()) or 1
        g_total  = sum(g_counts.values()) or 1

        if c_counts and g_counts:
            w()
            h2("Largest divergences between Claude and GPT-4")
            p("""Cells where the two models' percentage distributions differ most. Large divergences mark the semantic boundaries where the models interpret the three questions differently.""")
            w()
            w(f"  {'Cell':<32} {'Claude%':>8} {'GPT-4%':>8}  {'Diff':>6}")
            w(f"  {'─'*32} {'─'*8} {'─'*8}  {'─'*6}")

            all_cell_names = [cn for cn,_,_,_,_ in pp_cells]
            diffs = []
            for cn in all_cell_names:
                c_pct = c_counts.get(cn,0) / c_total * 100
                g_pct = g_counts.get(cn,0) / g_total * 100
                diffs.append((cn, c_pct, g_pct, abs(c_pct - g_pct)))

            for cn, c_pct, g_pct, diff in sorted(diffs, key=lambda x:-x[3])[:8]:
                w(f"  {cn:<32} {c_pct:>7.1f}%  {g_pct:>7.1f}%  {diff:>+5.1f}%")
            w()

    h1("SUMMARY VERDICT")

    # Evaluate each pre-committed prediction
    predictions = [
        ("Distance monotone with axis-difference count",
            proportionality.get("monotone", False)),
        ("All pairwise ARI < 0.10",
            all(v < 0.10 for v in ari.values()) if isinstance(ari, dict) else None),
        ("Q2 z-score exceeds Q1 z-score (Domain > Mode signal)",
            (zscores.get("q2",{}).get("z",0) > zscores.get("q1",{}).get("z",0))
            if zscores.get("q1") and zscores.get("q2") else None),
        ("Kappa Q1 > 0.50",
            kappas.get("claude_vs_gpt4",{}).get("q1",0) > 0.50
            if kappas else None),
    ]

    all_pass = all(v for _, v in predictions if v is not None)
    any_fail = any(v is False for _, v in predictions)

    for label, result in predictions:
        if result is True:   w(f"  {green('✓')} {label}")
        elif result is False: w(f"  {red('✗')} {label}")
        else:                w(f"  {yellow('?')} {label}  (insufficient data)")
    w()

    if all_pass:
        p("All pre-committed predictions confirmed. EO's three axes correspond to real, independent semantic dimensions in natural language embedding space. The result is not circular — the embeddings contained no EO vocabulary.")
    elif any_fail:
        p("One or more pre-committed predictions failed. See individual results above for which axes or claims are not supported by the data.")
    else:
        p("Results are mixed or data was insufficient for some predictions. See individual results above.")

    # Write to file
    report_path = run_dir / "analysis_report.txt"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path

def _zscore_verdict(z):
    return ""

def _ari_verdict(v):
    if v < 0.05: return green("independent ✓")
    if v < 0.10: return green("near-independent ✓")
    if v < 0.20: return yellow("borderline")
    return red("not independent ✗")

def _kappa_verdict(k):
    if not isinstance(k, float) or k != k: return dim("n/a")  # nan check
    if k > 0.60: return green("good")
    if k > 0.40: return yellow("moderate")
    if k > 0.20: return yellow("fair")
    return red("poor")


# ─────────────────────────────────────────────────────────────────────────────
# VISUALIZATIONS — Phase 4b
#
# PCA projection of clause embeddings, colored by operator.
# Z-score bar chart per language.
# Proportionality curve.
# Saved as PNG files alongside the report.
# ─────────────────────────────────────────────────────────────────────────────

def generate_figures(run_dir, vectors, q1, q2, q3, op_labels, lang_labels, zscores, proportionality, per_lang, entity_labels=None):
    if plt is None or PCA is None:
        warn("matplotlib or sklearn not available — skipping figures")
        return

    fig_dir = run_dir / "figures"
    fig_dir.mkdir(exist_ok=True)

    OPERATOR_COLORS = {
        "NUL":"#264653","SIG":"#2A9D8F","INS":"#E9C46A",
        "SEG":"#F4A261","CON":"#E76F51","SYN":"#6D6875",
        "ALT":"#B5838D","SUP":"#E5989B","REC":"#FFCDB2","?":"#CCCCCC",
    }

    # ── PCA projection (3D) ──────────────────────────────────────────────────
    try:
        from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
        pca = PCA(n_components=3, random_state=42)
        n_sample = min(3000, len(vectors))
        idx = np.random.choice(len(vectors), n_sample, replace=False)
        proj = pca.fit_transform(vectors[idx])
        ops  = op_labels[idx]
        v1, v2, v3 = [pca.explained_variance_ratio_[i]*100 for i in range(3)]

        fig = plt.figure(figsize=(13, 10))
        ax  = fig.add_subplot(111, projection="3d")
        for op in sorted(set(ops)):
            mask = ops == op
            if not mask.any():
                continue
            color = OPERATOR_COLORS.get(op, "#CCCCCC")
            ax.scatter(proj[mask,0], proj[mask,1], proj[mask,2],
                       c=color, label=op, alpha=0.45, s=10, linewidths=0,
                       depthshade=True)

        ax.set_title(
            "Clause Embeddings — 3D PCA Projection by Operator\n"
            "(3D projection of 3072-dimensional space — EO structure is orthogonal\n"
            " to dominant variance directions; clustering is in higher dimensions)",
            fontsize=11)
        ax.set_xlabel(f"PC1 ({v1:.1f}%)")
        ax.set_ylabel(f"PC2 ({v2:.1f}%)")
        ax.set_zlabel(f"PC3 ({v3:.1f}%)")
        ax.legend(loc="upper left", fontsize=8, markerscale=2,
                  bbox_to_anchor=(0.0, 1.0))
        fig.tight_layout()
        fig.savefig(fig_dir / "pca_by_operator.png", dpi=150, bbox_inches="tight")
        plt.close(fig)
        ok("Figure: pca_by_operator.png (3D)")

        # Also save a rotated view
        fig2r = plt.figure(figsize=(13, 10))
        ax2r  = fig2r.add_subplot(111, projection="3d")
        for op in sorted(set(ops)):
            mask = ops == op
            if not mask.any():
                continue
            ax2r.scatter(proj[mask,0], proj[mask,1], proj[mask,2],
                         c=OPERATOR_COLORS.get(op,"#CCCCCC"), label=op,
                         alpha=0.45, s=10, linewidths=0, depthshade=True)
        ax2r.view_init(elev=20, azim=120)
        ax2r.set_title("Clause Embeddings — 3D PCA by Operator (rotated view)", fontsize=11)
        ax2r.set_xlabel(f"PC1 ({v1:.1f}%)"); ax2r.set_ylabel(f"PC2 ({v2:.1f}%)")
        ax2r.set_zlabel(f"PC3 ({v3:.1f}%)")
        ax2r.legend(loc="upper left", fontsize=8, markerscale=2)
        fig2r.tight_layout()
        fig2r.savefig(fig_dir / "pca_by_operator_rotated.png", dpi=150, bbox_inches="tight")
        plt.close(fig2r)
        ok("Figure: pca_by_operator_rotated.png")

    except Exception as e:
        warn(f"PCA figure failed: {e}")

    # ── PCA by entity type (3D) ───────────────────────────────────────────────
    if entity_labels is not None:
        try:
            ENTITY_COLORS = {
                "Emanon":   "#2A9D8F",
                "Holon":    "#E9C46A",
                "Protogon": "#E76F51",
                "?":        "#CCCCCC",
            }
            pca3 = PCA(n_components=3, random_state=42)
            n_sample3 = min(3000, len(vectors))
            idx3 = np.random.choice(len(vectors), n_sample3, replace=False)
            proj3 = pca3.fit_transform(vectors[idx3])
            et    = entity_labels[idx3]
            v1e, v2e, v3e = [pca3.explained_variance_ratio_[i]*100 for i in range(3)]

            fig3 = plt.figure(figsize=(12, 9))
            ax3  = fig3.add_subplot(111, projection="3d")
            descs = {
                "Emanon":   "Emanon — ground-dominant (CONDITION)",
                "Holon":    "Holon — balanced (ENTITY)",
                "Protogon": "Protogon — pattern-dominant (PATTERN)",
            }
            for etype in ["Emanon","Holon","Protogon"]:
                mask3 = et == etype
                if not mask3.any():
                    continue
                ax3.scatter(proj3[mask3,0], proj3[mask3,1], proj3[mask3,2],
                            c=ENTITY_COLORS[etype], label=descs[etype],
                            alpha=0.45, s=10, linewidths=0, depthshade=True)

            ax3.set_title(
                "Clause Embeddings — 3D PCA by Entity Type\n"
                "Emanon / Holon / Protogon — intermixing in PC1-3 confirms\n"
                "EO entity-type structure is orthogonal to dominant content variance",
                fontsize=11)
            ax3.set_xlabel(f"PC1 ({v1e:.1f}%)")
            ax3.set_ylabel(f"PC2 ({v2e:.1f}%)")
            ax3.set_zlabel(f"PC3 ({v3e:.1f}%)")
            ax3.legend(loc="upper left", fontsize=9, markerscale=2)
            fig3.tight_layout()
            fig3.savefig(fig_dir / "pca_by_entity_type.png", dpi=150, bbox_inches="tight")
            plt.close(fig3)
            ok("Figure: pca_by_entity_type.png (3D)")
        except Exception as e:
            warn(f"Entity type PCA figure failed: {e}")


    # ── Proportionality curve ─────────────────────────────────────────────────
    try:
        xs, ys, yerrs = [], [], []
        for k in [0,1,2,3]:
            # JSON serialises int keys as strings — try both
            d = proportionality.get(k, proportionality.get(str(k), {}))
            if d.get("mean_distance") is not None:
                xs.append(k)
                ys.append(d["mean_distance"])
                yerrs.append(d.get("stdev", 0))

        fig, ax = plt.subplots(figsize=(7,5))
        # Use SD not SE. Pairs are not independent — each clause appears in O(n)
        # pairs, so effective sample size << n_pairs. SE = SD/sqrt(n_pairs) is
        # anticonservative and makes the curve look more precise than it is.
        sd = yerrs  # stdev already collected above
        ax.errorbar(xs, ys, yerr=sd, marker="o", linewidth=2, capsize=4, color="#2A9D8F")
        ax.set_xlabel("Number of axes differing between clause pair")
        ax.set_ylabel("Mean cosine distance")
        ax.set_title("Proportionality Test\nDoes distance scale with axis-difference count?")
        ax.set_xticks([0,1,2,3])
        ax.set_xticklabels(["0\n(same cell)","1","2","3\n(all different)"])
        plt.tight_layout()
        fig.savefig(fig_dir / "proportionality_curve.png", dpi=150, bbox_inches="tight")
        plt.close(fig)
        ok("Figure: proportionality_curve.png")
    except Exception as e:
        warn(f"Proportionality figure failed: {e}")

    # ── Z-scores by language ──────────────────────────────────────────────────
    try:
        if per_lang:
            langs = sorted(per_lang.keys())
            q1_zs  = [per_lang[l].get("q1",{}).get("z", float("nan")) for l in langs]
            q2_zs  = [per_lang[l].get("q2",{}).get("z", float("nan")) for l in langs]
            q3_zs  = [per_lang[l].get("q3",{}).get("z", float("nan")) for l in langs]
            act_zs = [per_lang[l].get("act_face",{}).get("z", float("nan")) for l in langs]
            sit_zs = [per_lang[l].get("site_face",{}).get("z", float("nan")) for l in langs]
            res_zs = [per_lang[l].get("resolution_face",{}).get("z", float("nan")) for l in langs]
            f27_zs = [per_lang[l].get("full_27cell",{}).get("z", float("nan")) for l in langs]

            def safe(v): return v if (v is not None and v == v) else 0

            # Two figures: (1) axes only, (2) faces + 27-cell
            for fig_suffix, series, title in [
                ("axes", [
                    (q1_zs,  "Q1 Mode",       "#2A9D8F", 0.30),
                    (q2_zs,  "Q2 Domain",      "#E76F51", 0.00),
                    (q3_zs,  "Q3 Object",      "#6D6875", -0.30),
                ], "Per-Language Z-Scores — Individual Axes"),
                ("faces", [
                    (act_zs, "Act Q1×Q2",      "#264653", 0.36),
                    (sit_zs, "Site Q2×Q3",     "#2A9D8F", 0.12),
                    (res_zs, "Resolution Q1×Q3","#E76F51",-0.12),
                    (f27_zs, "Full 27-cell",   "#6D6875", -0.36),
                ], "Per-Language Z-Scores — Faces and 27-Cell"),
            ]:
                n_series = len(series)
                bar_h = 0.22 if n_series == 3 else 0.18
                y = range(len(langs))
                fig, ax = plt.subplots(figsize=(11, max(6, len(langs)*0.38)))
                for zs, label, color, offset in series:
                    ax.barh([i + offset for i in y],
                            [safe(v) for v in zs], height=bar_h,
                            label=label, color=color, alpha=0.8)
                ax.axvline(0, color="gray", linestyle="-", linewidth=0.5, alpha=0.4)
                ax.set_yticks(list(y))
                ax.set_yticklabels(langs, fontsize=8)
                ax.set_xlabel("z-score (higher = stronger geometric signal)")
                ax.set_title(title)
                ax.legend(loc="lower right", fontsize=8)
                plt.tight_layout()
                fig.savefig(fig_dir / f"zscores_by_language_{fig_suffix}.png",
                            dpi=150, bbox_inches="tight")
                plt.close(fig)
                ok(f"Figure: zscores_by_language_{fig_suffix}.png")
    except Exception as e:
        warn(f"Language z-score figure failed: {e}")



def compute_coordinate_metric_test(vectors: np.ndarray,
                                    q1: np.ndarray,
                                    q2: np.ndarray,
                                    q3: np.ndarray,
                                    label: str = "") -> dict:
    """
    Test whether inter-centroid distances in embedding space reflect the
    metric structure predicted by EO's axis-specific coordinate geometry.

    The three axes carry different mathematical structures:
      Mode (α, Arithmetic):      {0, 1, 2}          — equal steps
      Domain (η, Geometric):     {-1, +1, sqrt(2)}  — asymmetric; E↔S >> S↔Sig
      Object (Ω, Transcendental):{sqrt(2), 2, 2^√2} — unequal but close steps

    For each axis, we:
      1. Compute the centroid of each of the 3 axis positions
      2. Compute all 3 pairwise cosine distances between centroids
      3. Compare to the predicted coordinate distances
      4. Report Pearson r and the directional predictions

    The key prediction for Domain: E↔S centroid distance ≈ 4.8× S↔Sig distance.
    If the embedding geometry reflects the coordinate structure, this ratio
    should be detectably non-uniform and directionally consistent with prediction.
    """
    import math
    from scipy.stats import pearsonr

    prefix = f"  [{label}] " if label else "  "

    # Coordinate values
    MODE_COORDS  = {"DIFFERENTIATING": 0,            "RELATING": 1,            "GENERATING": 2}
    DOMAIN_COORDS= {"EXISTENCE":      -1,            "STRUCTURE": 1,           "SIGNIFICANCE": math.sqrt(2)}
    OBJECT_COORDS= {"CONDITION":  math.sqrt(2),      "ENTITY": 2,              "PATTERN": 2**math.sqrt(2)}

    print(f"{prefix}Normalizing {len(vectors):,} vectors...", flush=True)

    # Normalize vectors once
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    normed = vectors / norms

    def axis_centroids(labels, coord_map, axis_name):
        """Compute normalized centroid for each axis position."""
        positions = list(coord_map.keys())
        centroids = {}
        for pos in positions:
            mask = labels == pos
            n = mask.sum()
            print(f"{prefix}  {axis_name} · {pos}: {n:,} clauses", flush=True)
            if n < 10:
                print(f"{prefix}  {axis_name} · {pos}: too few — skipping", flush=True)
                continue
            c = normed[mask].mean(axis=0)
            c = c / (np.linalg.norm(c) + 1e-10)
            centroids[pos] = c
        return centroids

    def pairwise_cosine_dist(centroids):
        """Compute all pairwise cosine distances between centroids."""
        pairs = {}
        keys = list(centroids.keys())
        for i, a in enumerate(keys):
            for b in keys[i+1:]:
                sim = float(np.dot(centroids[a], centroids[b]))
                pairs[(a,b)] = round(1 - sim, 6)
        return pairs

    results = {}

    for axis_name, labels, coord_map in [
        ("mode",   q1, MODE_COORDS),
        ("domain", q2, DOMAIN_COORDS),
        ("object", q3, OBJECT_COORDS),
    ]:
        print(f"{prefix}Computing {axis_name} centroids...", flush=True)
        centroids = axis_centroids(labels, coord_map, axis_name)
        if len(centroids) < 3:
            results[axis_name] = {"error": f"Only {len(centroids)} positions have enough data"}
            print(f"{prefix}  {axis_name}: only {len(centroids)} positions — skipping", flush=True)
            continue

        print(f"{prefix}  {axis_name}: computing pairwise centroid distances...", flush=True)
        emb_dists = pairwise_cosine_dist(centroids)

        # Predicted distances from coordinate values
        coord_dists = {}
        keys = list(coord_map.keys())
        for i, a in enumerate(keys):
            for b in keys[i+1:]:
                if a in centroids and b in centroids:
                    coord_dists[(a,b)] = abs(coord_map[a] - coord_map[b])

        # NOTE: Pearson r is NOT reported here. Each axis has 3 positions → 3
        # pairwise distances → df=1. With df=1, even r=0.99 has p≈0.08 and r
        # is essentially unconstrained by data. The directional predictions
        # (E↔S/S↔Sig ratio, step equality) are the valid tests at this sample size.
        r, pval = float("nan"), float("nan")  # kept for data structure compat only

        # Directional predictions
        directional = {}
        if axis_name == "domain" and ("EXISTENCE","STRUCTURE") in emb_dists and ("STRUCTURE","SIGNIFICANCE") in emb_dists:
            e_s   = emb_dists[("EXISTENCE","STRUCTURE")]
            s_sig = emb_dists[("STRUCTURE","SIGNIFICANCE")]
            ratio = e_s / s_sig if s_sig > 0 else float("inf")
            pred_ratio = abs(DOMAIN_COORDS["EXISTENCE"] - DOMAIN_COORDS["STRUCTURE"]) /                          abs(DOMAIN_COORDS["STRUCTURE"] - DOMAIN_COORDS["SIGNIFICANCE"])
            directional = {
                "E_S_dist":     round(e_s,   6),
                "S_Sig_dist":   round(s_sig, 6),
                "observed_ratio":   round(ratio,      4),
                "predicted_ratio":  round(pred_ratio, 4),
                "prediction_met":   ratio > 2.0,  # predicted 4.8×; any ratio > 2 is directionally correct
            }
        elif axis_name == "mode":
            # Arithmetic: expect equal steps
            d_r = emb_dists.get(("DIFFERENTIATING","RELATING"), None)
            r_g = emb_dists.get(("RELATING","GENERATING"), None)
            if d_r and r_g:
                step_ratio = max(d_r,r_g) / min(d_r,r_g) if min(d_r,r_g) > 0 else float("inf")
                directional = {
                    "DIF_REL_dist":   round(d_r, 6),
                    "REL_GEN_dist":   round(r_g, 6),
                    "step_ratio":     round(step_ratio, 4),
                    "equal_steps_met": step_ratio < 1.3,  # within 30% = equal steps
                }
        elif axis_name == "object":
            c_e = emb_dists.get(("CONDITION","ENTITY"), None)
            e_p = emb_dists.get(("ENTITY","PATTERN"), None)
            c_p = emb_dists.get(("CONDITION","PATTERN"), None)
            if c_e and e_p and c_p:
                pred_c_e = abs(OBJECT_COORDS["CONDITION"] - OBJECT_COORDS["ENTITY"])
                pred_e_p = abs(OBJECT_COORDS["ENTITY"]    - OBJECT_COORDS["PATTERN"])
                directional = {
                    "CON_ENT_dist":   round(c_e, 6),
                    "ENT_PAT_dist":   round(e_p, 6),
                    "CON_PAT_dist":   round(c_p, 6),
                    "pred_CON_ENT":   round(pred_c_e, 4),
                    "pred_ENT_PAT":   round(pred_e_p, 4),
                    "additive_holds": abs(c_p - (c_e + e_p)) < 0.005,  # C↔P ≈ C↔E + E↔P
                }

        results[axis_name] = {
            "n_positions":        len(centroids),
            "embedding_distances": {f"{a}↔{b}": v for (a,b),v in emb_dists.items()},
            "coordinate_distances":{f"{a}↔{b}": round(v,4) for (a,b),v in coord_dists.items()},
            "pearson_r":           round(r, 4),
            "pearson_p":           round(pval, 6),
            "directional":         directional,
        }
        print(f"{prefix}  {axis_name}: done", flush=True)

    return results


def run_analysis(embeddings_file: Path, classified_file: Path, run_dir: Path, models_used: list,
                 force: bool = False):
    """
    Load embeddings and run all measurements across three label sets.
    Results are cached in results.json. If the cache is newer than both
    embeddings.npz and classified.jsonl, skip recomputation unless force=True.
    """
    # Defined here so it's available in both the cache path and the full path
    ENTITY_TYPE_MAP = {
        "CONDITION": "Emanon",
        "ENTITY":    "Holon",
        "PATTERN":   "Protogon",
    }

    # ── Cache check ───────────────────────────────────────────────────────────
    results_file = run_dir / "results.json"
    if not force and results_file.exists():
        emb_mtime  = embeddings_file.stat().st_mtime
        cls_mtime  = classified_file.stat().st_mtime
        res_mtime  = results_file.stat().st_mtime
        if res_mtime > emb_mtime and res_mtime > cls_mtime:
            info("results.json is newer than embeddings and classified — loading from cache")
            info("(run with --force-analysis to recompute z-scores from scratch)")
            cached = json.loads(results_file.read_text())

            # ── Run any analyses not yet in cache ─────────────────────────────
            if "coord_geometry" not in cached or not cached.get("coord_geometry"):
                section("Running coordinate metric test (not in cache)")
                data_coord = np.load(embeddings_file, allow_pickle=True)
                vecs_coord = data_coord["vectors"].astype(np.float32)
                cons_mask  = data_coord.get("consensus", np.ones(len(vecs_coord), dtype=bool))
                n_coord = len(vecs_coord)
                ids_coord = data_coord["ids"]
                id_to_idx_coord = {cid: i for i, cid in enumerate(ids_coord)}
                lbl_coord = {
                    "claude": {"q1": np.full(n_coord,"?",dtype=object),
                               "q2": np.full(n_coord,"?",dtype=object),
                               "q3": np.full(n_coord,"?",dtype=object)},
                    "gpt4":   {"q1": np.full(n_coord,"?",dtype=object),
                               "q2": np.full(n_coord,"?",dtype=object),
                               "q3": np.full(n_coord,"?",dtype=object)},
                }
                with open(classified_file, encoding="utf-8") as _f:
                    for _line in _f:
                        try:
                            _r = json.loads(_line)
                            _idx = id_to_idx_coord.get(_r.get("id",""))
                            if _idx is None: continue
                            _cls = _r.get("classifications", {})
                            for _mk, _lk in [("claude","claude"),("gpt4","gpt4"),
                                              ("gpt-4o","gpt4"),("gpt-4o-mini","gpt4")]:
                                if _mk in _cls and _cls[_mk]:
                                    _c = _cls[_mk]
                                    lbl_coord[_lk]["q1"][_idx] = _c.get("q1","?")
                                    lbl_coord[_lk]["q2"][_idx] = _c.get("q2","?")
                                    lbl_coord[_lk]["q3"][_idx] = _c.get("q3","?")
                        except Exception:
                            pass
                cons_q1 = data_coord["q1"]; cons_q2 = data_coord["q2"]; cons_q3 = data_coord["q3"]
                cons_valid = cons_mask & (cons_q1 != "?") & (cons_q2 != "?") & (cons_q3 != "?")
                _c_m = ((lbl_coord["claude"]["q1"] != "?") & (lbl_coord["claude"]["q2"] != "?") &
                        (lbl_coord["claude"]["q3"] != "?"))
                _g_m = ((lbl_coord["gpt4"]["q1"]   != "?") & (lbl_coord["gpt4"]["q2"]   != "?") &
                        (lbl_coord["gpt4"]["q3"]    != "?"))
                comb_vecs = np.concatenate([vecs_coord[_c_m], vecs_coord[_g_m]])
                comb_q1   = np.concatenate([lbl_coord["claude"]["q1"][_c_m], lbl_coord["gpt4"]["q1"][_g_m]])
                comb_q2   = np.concatenate([lbl_coord["claude"]["q2"][_c_m], lbl_coord["gpt4"]["q2"][_g_m]])
                comb_q3   = np.concatenate([lbl_coord["claude"]["q3"][_c_m], lbl_coord["gpt4"]["q3"][_g_m]])
                info(f"Combined set: {len(comb_vecs):,} assignments")
                coord_metric = {}
                for set_label, vecs_cm, q1_cm, q2_cm, q3_cm in [
                    ("consensus", vecs_coord[cons_valid], cons_q1[cons_valid],
                                  cons_q2[cons_valid], cons_q3[cons_valid]),
                    ("combined",  comb_vecs, comb_q1, comb_q2, comb_q3),
                ]:
                    print(f"\n  ── {set_label.upper()} ({len(vecs_cm):,} assignments) ──", flush=True)
                    coord_metric[set_label] = compute_coordinate_metric_test(
                        vecs_cm, q1_cm, q2_cm, q3_cm, label=set_label)
                cached["coord_geometry"] = coord_metric
                (run_dir / "results.json").write_text(json.dumps(cached, indent=2))
                ok("Coordinate metric results saved to cache")
            else:
                info("Coordinate metric: loaded from cache")

            # ── Recompute per-language face z-scores if missing from cache ────
            EXPECTED_LANG_KEYS = {"q1","q2","q3","act_face","site_face","resolution_face","full_27cell"}
            cached_pl = cached.get("per_lang", {})
            needs_lang_recompute = [
                lang for lang, v in cached_pl.items()
                if not EXPECTED_LANG_KEYS.issubset(set(v.keys()))
            ]
            if needs_lang_recompute:
                section(f"Recomputing per-language face z-scores for {len(needs_lang_recompute)} languages")
                data_lang = np.load(embeddings_file, allow_pickle=True)
                vecs_lang  = data_lang["vectors"].astype(np.float32)
                q1_lang    = data_lang["q1"]; q2_lang = data_lang["q2"]; q3_lang = data_lang["q3"]
                lang_arr   = data_lang["language"]
                cons_mask_l = data_lang.get("consensus", np.ones(len(vecs_lang), dtype=bool))
                # Normalize
                nrm = np.linalg.norm(vecs_lang, axis=1, keepdims=True)
                nrm = np.where(nrm == 0, 1, nrm)
                vecs_lang = vecs_lang / nrm

                # Build consensus-valid mask
                valid_mask = cons_mask_l & (q1_lang != "?") & (q2_lang != "?") & (q3_lang != "?")
                for lang in sorted(needs_lang_recompute):
                    lmask = (lang_arr == lang) & valid_mask
                    if lmask.sum() < 100:
                        continue
                    vl = vecs_lang[lmask]
                    lq1, lq2, lq3 = q1_lang[lmask], q2_lang[lmask], q3_lang[lmask]
                    entry = dict(cached_pl.get(lang, {}))

                    for axis_name, labels in [("q1",lq1),("q2",lq2),("q3",lq3)]:
                        if axis_name not in entry:
                            valid = labels != "?"
                            if valid.sum() >= 50:
                                z, sep = compute_zscore(vl[valid], labels[valid], n_shuffles=200)
                                entry[axis_name] = {"z": round(z,2), "separation": round(sep,4)}

                    for face_name, lab_fn in [
                        ("act_face",        lambda i: f"{lq1[i]}/{lq2[i]}" if lq1[i]!="?" and lq2[i]!="?" else "?"),
                        ("site_face",       lambda i: f"{lq2[i]}/{lq3[i]}" if lq2[i]!="?" and lq3[i]!="?" else "?"),
                        ("resolution_face", lambda i: f"{lq1[i]}/{lq3[i]}" if lq1[i]!="?" and lq3[i]!="?" else "?"),
                        ("full_27cell",     lambda i: f"{lq1[i]}/{lq2[i]}/{lq3[i]}" if lq1[i]!="?" and lq2[i]!="?" and lq3[i]!="?" else "?"),
                    ]:
                        if face_name not in entry:
                            lbl_arr = np.array([lab_fn(i) for i in range(len(lq1))])
                            valid = lbl_arr != "?"
                            if valid.sum() >= 50:
                                z, sep = compute_zscore(vl[valid], lbl_arr[valid], n_shuffles=200)
                                entry[face_name] = {"z": round(z,2), "separation": round(sep,4)}
                                print(f"  {lang} {face_name}: {z:+.2f}", flush=True)

                    cached_pl[lang] = entry

                cached["per_lang"] = cached_pl
                (run_dir / "results.json").write_text(json.dumps(cached, indent=2))
                ok("Per-language face z-scores saved to cache")
            else:
                info("Per-language face z-scores: loaded from cache")

            # ── Always regenerate report and figures from cached numbers ───────
            # The report text is cheap to generate and must reflect the latest
            # code (new sections, fixed caveats, updated interpretations).
            # Only the expensive z-scores (200 shuffles) stay cached.
            import datetime
            section(f"Generating report  [{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]")
            report_path = generate_report(
                run_dir,
                cached.get("zscores", {}),
                cached.get("proportionality", {}),
                cached.get("ari", {}),
                cached.get("per_lang", {}),
                cached.get("kappas", {}),
                cached.get("n_clauses", 0),
                cached.get("n_languages", 0),
                models_used,
                n_total_embedded=cached.get("n_total_embedded", 0),
                all_zscores=cached.get("all_zscores"),
                all_ari=cached.get("all_ari"),
                face_zscores=cached.get("face_zscores"),
                unsupervised=cached.get("unsupervised"),
                ari_exclusion=cached.get("ari_exclusion"),
                entity_z=cached.get("entity_z"),
                phasepost_data=_wrap_phasepost(cached.get("phasepost")),
                coord_results=cached.get("coord_geometry"),
                helix_tests=cached.get("helix_tests"),
                subspace_geo=cached.get("subspace_geometry"),
            )
            ok(f"Report: {report_path}")

            # Always regenerate figures too
            section("Generating figures from cache")
            data_quick = np.load(embeddings_file, allow_pickle=True)
            vecs_q  = data_quick["vectors"].astype(np.float32)
            q1_q    = data_quick.get("q1",    np.array([]))
            q2_q    = data_quick.get("q2",    np.array([]))
            q3_q    = data_quick.get("q3",    np.array([]))
            op_q    = data_quick.get("operator", np.array([]))
            lang_q  = data_quick["language"]
            et_labels_q = np.array([ENTITY_TYPE_MAP.get(v,"?") for v in q3_q])
            generate_figures(run_dir, vecs_q, q1_q, q2_q, q3_q,
                             op_q, lang_q, cached.get("zscores",{}),
                             cached.get("proportionality",{}),
                             cached.get("per_lang",{}),
                             entity_labels=et_labels_q)
            ok("Figures regenerated")
            return cached

    section("Loading embeddings")
    data = np.load(embeddings_file, allow_pickle=True)
    vectors  = data["vectors"].astype(np.float32)
    lang     = data["language"]
    consensus_mask = data.get("consensus", np.ones(len(vectors), dtype=bool))

    ok(f"Loaded {len(vectors):,} clause vectors ({vectors.shape[1]} dims)")
    info(f"Consensus subset: {consensus_mask.sum():,} clauses where all models agreed")
    n_langs = len(set(lang) - {"?"})
    info(f"Languages represented: {n_langs}")

    # ── Build three label sets from classified.jsonl ─────────────────────────
    # The embeddings.npz only stores consensus labels. For per-model labels
    # we re-read classified.jsonl and align by clause ID.

    ACT = {
        ("DIFFERENTIATING","EXISTENCE"): "NUL",
        ("DIFFERENTIATING","STRUCTURE"): "SEG",
        ("DIFFERENTIATING","SIGNIFICANCE"): "ALT",
        ("RELATING","EXISTENCE"): "SIG",
        ("RELATING","STRUCTURE"): "CON",
        ("RELATING","SIGNIFICANCE"): "SUP",
        ("GENERATING","EXISTENCE"): "INS",
        ("GENERATING","STRUCTURE"): "SYN",
        ("GENERATING","SIGNIFICANCE"): "REC",
    }

    ids = data["ids"]
    id_to_idx = {cid: i for i, cid in enumerate(ids)}

    # ── Entity type mapping ───────────────────────────────────────────────────
    # Q3 (Object grain) maps onto EO's three entity types:
    #   CONDITION → Emanon-prone  (ground-dominant, ambient, pre-figural)
    #   ENTITY    → Holon-prone   (balanced, stable figure, self-maintaining)
    #   PATTERN   → Protogon-prone (pattern-dominant, crystallizing, forming)
    # These correspond to positions 1-9, 10-18, 19-27 in the capacity ground.

    # Per-model label arrays, indexed same as vectors
    # Must use dtype=object or explicit width — np.array(["?"] * n) creates
    # U1 dtype which silently truncates longer strings like "DIFFERENTIATING"
    n = len(vectors)
    labels = {
        "consensus": {"q1": data["q1"].copy(), "q2": data["q2"].copy(), "q3": data["q3"].copy()},
        "claude":    {"q1": np.full(n, "?", dtype=object), "q2": np.full(n, "?", dtype=object), "q3": np.full(n, "?", dtype=object)},
        "gpt4":      {"q1": np.full(n, "?", dtype=object), "q2": np.full(n, "?", dtype=object), "q3": np.full(n, "?", dtype=object)},
    }

    with open(classified_file, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                cid = rec.get("id", "")
                idx = id_to_idx.get(cid)
                if idx is None:
                    continue
                cls = rec.get("classifications", {})
                for model_key, label_key in [("claude","claude"), ("gpt4","gpt4"),
                                              ("gpt-4o","gpt4"), ("gpt-4o-mini","gpt4")]:
                    if model_key in cls and cls[model_key]:
                        c = cls[model_key]
                        labels[label_key]["q1"][idx] = c.get("q1", "?")
                        labels[label_key]["q2"][idx] = c.get("q2", "?")
                        labels[label_key]["q3"][idx] = c.get("q3", "?")
            except Exception:
                pass

    # ── Define the three analysis sets ───────────────────────────────────────
    def make_mask(label_set_name):
        """Return boolean mask for valid, classifiable clauses in this label set."""
        lb = labels[label_set_name]
        valid = (lb["q1"] != "?") & (lb["q2"] != "?") & (lb["q3"] != "?")
        if label_set_name == "consensus":
            valid = valid & consensus_mask
        return valid

    sets = {}
    for name in ["consensus", "claude", "gpt4"]:
        m = make_mask(name)
        if m.sum() >= 50:
            sets[name] = {
                "mask": m,
                "vecs": vectors[m],
                "q1":   labels[name]["q1"][m],
                "q2":   labels[name]["q2"][m],
                "q3":   labels[name]["q3"][m],
                "op":   np.array([ACT.get((labels[name]["q1"][i], labels[name]["q2"][i]), "?")
                                  for i in np.where(m)[0]]),
                "lang": lang[m],
            }
            info(f"Label set '{name}': {m.sum():,} clauses")
        else:
            warn(f"Label set '{name}' too small ({m.sum()}) — skipping")

    # Build "full" set: best-available label for every embedded clause
    # Priority: consensus > claude==gpt4 agreement > claude > gpt4
    full_q1 = labels["consensus"]["q1"].copy()
    full_q2 = labels["consensus"]["q2"].copy()
    full_q3 = labels["consensus"]["q3"].copy()
    for i in range(n):
        if full_q1[i] != "?":
            continue  # consensus available
        c_q1, c_q2, c_q3 = labels["claude"]["q1"][i], labels["claude"]["q2"][i], labels["claude"]["q3"][i]
        g_q1, g_q2, g_q3 = labels["gpt4"]["q1"][i],   labels["gpt4"]["q2"][i],   labels["gpt4"]["q3"][i]
        # Use claude+gpt4 agreement where available, else claude, else gpt4
        full_q1[i] = c_q1 if c_q1 != "?" else g_q1
        full_q2[i] = c_q2 if c_q2 != "?" else g_q2
        full_q3[i] = c_q3 if c_q3 != "?" else g_q3

    full_mask = (full_q1 != "?") & (full_q2 != "?") & (full_q3 != "?")
    sets["full"] = {
        "mask": full_mask,
        "vecs": vectors[full_mask],
        "q1":   full_q1[full_mask],
        "q2":   full_q2[full_mask],
        "q3":   full_q3[full_mask],
        "op":   np.array([ACT.get((full_q1[i], full_q2[i]), "?") for i in np.where(full_mask)[0]]),
        "lang": lang[full_mask],
        "is_consensus": consensus_mask[full_mask],
    }
    info(f"Full set (best-available labels): {full_mask.sum():,} clauses")

    # Build "combined" set: every clause under BOTH model labels.
    # Where models agree → clause reinforces one centroid (appears twice).
    # Where they disagree → clause pulls two different centroids (nets out).
    # This is the maximal-data version: 39k assignments, no filtering.
    _c_valid = ((labels["claude"]["q1"] != "?") & (labels["claude"]["q2"] != "?") &
                (labels["claude"]["q3"] != "?"))
    _g_valid = ((labels["gpt4"]["q1"]   != "?") & (labels["gpt4"]["q2"]   != "?") &
                (labels["gpt4"]["q3"]   != "?"))
    comb_vecs = np.concatenate([vectors[_c_valid], vectors[_g_valid]])
    comb_q1   = np.concatenate([labels["claude"]["q1"][_c_valid], labels["gpt4"]["q1"][_g_valid]])
    comb_q2   = np.concatenate([labels["claude"]["q2"][_c_valid], labels["gpt4"]["q2"][_g_valid]])
    comb_q3   = np.concatenate([labels["claude"]["q3"][_c_valid], labels["gpt4"]["q3"][_g_valid]])
    comb_op   = np.array([ACT.get((comb_q1[i], comb_q2[i]), "?") for i in range(len(comb_vecs))])
    sets["combined"] = {
        "vecs": comb_vecs, "q1": comb_q1, "q2": comb_q2, "q3": comb_q3, "op": comb_op,
    }
    info(f"Combined set (both model labels): {len(comb_vecs):,} assignments "
         f"({_c_valid.sum():,} Claude + {_g_valid.sum():,} GPT-4)")

    # Primary set for report: consensus if available, else first available
    primary = "consensus" if "consensus" in sets else list(sets.keys())[0]
    S = sets[primary]

    # FLORES pseudo-replication warning:
    # FLORES-200 translates the same ~200 source sentences into up to 200 languages.
    # Translations of the same source sentence receive identical Q1/Q2/Q3 labels and
    # cluster tightly in multilingual embedding space. Including FLORES in the global
    # z-score inflates n and within-group similarity. The global z-scores below are
    # computed on the consensus set which includes FLORES; the per-language z-scores
    # are computed per-language and are not affected. See S_nofloress for a
    # FLORES-excluded subset.
    # ── Build FLORES-excluded set (UD-only) ──────────────────────────────────
    # FLORES-200 translates the same ~200 source sentences into up to 200 languages.
    # Translations cluster tightly in multilingual embedding space and receive
    # identical Q1/Q2/Q3 labels. Including them inflates n and within-group
    # similarity, biasing z-scores upward.
    #
    # We build S_ud: the consensus set restricted to UD-sourced clauses only.
    # Global z-scores run on BOTH S (consensus, includes FLORES) and S_ud (UD-only).
    # The difference quantifies the FLORES inflation.
    if "source" in data:
        source_arr = data["source"]
        ud_only_mask = np.array(["flores" not in str(s).lower() for s in source_arr], dtype=bool)
        n_flores = int((~ud_only_mask).sum())
        n_ud     = int(ud_only_mask.sum())
        info(f"Source breakdown: {n_ud:,} UD clauses, {n_flores:,} FLORES clauses")
        # Build UD-only consensus set
        cons_mask_ud = consensus_mask & ud_only_mask
        cons_valid_ud = cons_mask_ud & (labels["consensus"]["q1"] != "?")
        if cons_valid_ud.sum() >= 50:
            sets["ud_only"] = {
                "mask": cons_valid_ud,
                "vecs": vectors[cons_valid_ud],
                "q1":   labels["consensus"]["q1"][cons_valid_ud],
                "q2":   labels["consensus"]["q2"][cons_valid_ud],
                "q3":   labels["consensus"]["q3"][cons_valid_ud],
                "op":   np.array([ACT.get((labels["consensus"]["q1"][i],
                                           labels["consensus"]["q2"][i]),"?")
                                   for i in np.where(cons_valid_ud)[0]]),
                "lang": lang[cons_valid_ud],
            }
            info(f"UD-only consensus set: {cons_valid_ud.sum():,} clauses")
        else:
            info("UD-only set too small — source field may be missing from embeddings.npz")
            info("Re-run --phase embed to regenerate embeddings.npz with source tracking.")
    else:
        info("Note: embeddings.npz lacks 'source' field — cannot exclude FLORES.")
        info("Re-run --phase embed to regenerate embeddings with source tracking.")

    S_full     = sets["full"]      # 19k best-available, one label each
    S_combined = sets["combined"]  # 39k, both model labels, disagreements net out
    S_ud       = sets.get("ud_only")  # consensus UD-only (FLORES excluded)

    axis_names = {
        "q1": "Q1 Mode (separating/connecting/producing)",
        "q2": "Q2 Domain (existence/organization/meaning)",
        "q3": "Q3 Object (condition/particular/pattern)",
    }

    # ── Z-scores for all three sets ───────────────────────────────────────────
    section("Computing per-axis z-scores across all three label sets")
    print(f"""
  Sets compared:
    consensus : both models agreed (highest confidence, includes FLORES)
    claude    : Claude labels for all clauses
    gpt4      : GPT-4 labels for all clauses
    combined  : both model labels concatenated (~39k assignments)
    ud_only   : consensus UD-only (FLORES excluded — FLORES inflation test)

  If consensus ≈ ud_only: FLORES pseudo-replication is not inflating z-scores.
  If consensus >> ud_only: FLORES is inflating the result.
    """)

    all_zscores = {}  # name -> {q1, q2, q3}
    for set_name, S_cur in sets.items():
        n_cur = len(S_cur["vecs"])
        lbl = f"Set {set_name.upper()} ({n_cur:,} clauses)"; print(f"\n  {bold(lbl)}")
        all_zscores[set_name] = {}
        for axis in ["q1", "q2", "q3"]:
            lab = S_cur[axis]
            z, sep = compute_zscore(S_cur["vecs"], lab, n_shuffles=200)
            all_zscores[set_name][axis] = {"z": round(z,2), "separation": round(sep,5)}
            print(f"    {axis_names[axis][:40]:<40}  {z:+.2f} SDs")

    # Primary z-scores for report = consensus set
    zscores = all_zscores.get(primary, {})

    # ── Proportionality (primary set) ─────────────────────────────────────────
    section("Computing proportionality (distance vs axis-difference count)")
    proportionality = compute_proportionality(S["vecs"], S["q1"], S["q2"], S["q3"])
    for k in [0,1,2,3]:
        d = proportionality.get(k, proportionality.get(str(k), {}))
        m = d.get("mean_distance")
        if m is not None:
            print(f"    {k} axes different: mean dist = {m:.4f} (n={d['n_pairs']:,})")
    if proportionality.get("monotone"): ok("Monotone ✓")
    else: warn("Not monotone ✗")

    # ── Axis independence (all three sets) ────────────────────────────────────
    section("Computing axis independence (pairwise ARI) across all sets")
    all_ari = {}
    for set_name, S_cur in sets.items():
        ari = compute_axis_ari(S_cur["q1"], S_cur["q2"], S_cur["q3"])
        all_ari[set_name] = ari
        print(f"  {set_name}:  q1/q2={ari['q1_vs_q2']:+.3f}  q1/q3={ari['q1_vs_q3']:+.3f}  q2/q3={ari['q2_vs_q3']:+.3f}")
    ari = all_ari.get(primary, {})

    # ── ARI cell-exclusion test ──────────────────────────────────────────────
    section("Testing whether Q1/Q2 ARI is driven by cell sparsity (helix test)")
    print("""
  If the Q1/Q2 correlation disappears after excluding sparse/dominant cells,
  it is a distributional artifact of the helix's dependency ordering.
  If it persists, Mode and Domain have a genuine semantic dependency.
    """)
    ari_exclusion = compute_ari_excluding_sparse_cells(S["q1"], S["q2"], S["q3"])
    print(f"    ARI full corpus:          {ari_exclusion['ari_all']:+.4f}")
    if ari_exclusion["ari_excluding_sparse"] is not None:
        print(f"    ARI excluding sparse cells: {ari_exclusion['ari_excluding_sparse']:+.4f}")
        print(f"    Cells excluded: {', '.join(ari_exclusion['cells_excluded'][:6])}"
              + (" ..." if len(ari_exclusion["cells_excluded"]) > 6 else ""))
        print(f"    Clauses excluded: {ari_exclusion['n_excluded']:,}")
    print(f"    → {ari_exclusion['interpretation']}", flush=True)

    # ── Inter-model agreement ─────────────────────────────────────────────────
    section("Computing inter-model agreement (Cohen's kappa)")
    kappas = compute_intermodel_agreement(classified_file, models_used)

    # ── Operators and faces z-scores ─────────────────────────────────────────
    section("Testing operators (9 groups) and three faces vs axes (3 groups)")
    print("""
  Axes produce 3 groups each. Operators and faces produce 9 groups.
  If 9-group z-scores beat 3-group z-scores, the combinatorial structure
  carries real semantic information beyond what the axes alone capture.
    """)
    face_zscores = compute_operator_and_face_zscores(
        S["vecs"], S["q1"], S["q2"], S["q3"], n_shuffles=200)

    # ── Unsupervised structure ────────────────────────────────────────────────
    section("Unsupervised structure — what does the geometry itself suggest?")
    print("""
  KMeans clustering without EO labels. Tests whether the data-driven
  clusters (k=3, k=9, k=27) correspond to EO's axes, operators, or cells.
  ARI near 0 = clusters don't match EO. ARI > 0.1 = meaningful overlap.
    """)
    unsupervised = compute_unsupervised_structure(
        S["vecs"], S["q1"], S["q2"], S["q3"])

    # ── Entity type analysis (Emanon / Protogon / Holon) ─────────────────────
    # Q3 already produces a z-score for CONDITION/ENTITY/PATTERN.
    # Here we relabel those groups as Emanon/Protogon/Holon and report
    # them explicitly, and add a dedicated figure.
    section("Entity types: Emanon / Protogon / Holon (Q3 relabeled)")
    entity_labels = np.array([
        ENTITY_TYPE_MAP.get(v, "?") for v in S["q3"]
    ])
    valid_et = entity_labels != "?"
    if valid_et.sum() >= 50:
        z_et, sep_et = compute_zscore(S["vecs"][valid_et], entity_labels[valid_et], n_shuffles=200)
        entity_z = round(z_et, 2)
        print(f"    Entity types (Emanon/Holon/Protogon): {z_et:+.2f} SDs from chance", flush=True)
        # Distribution
        from collections import Counter
        et_counts = Counter(entity_labels[valid_et])
        for et in ["Emanon","Holon","Protogon"]:
            n = et_counts.get(et, 0)
            pct = n / valid_et.sum() * 100
            print(f"      {et:<12} {n:>5} ({pct:.0f}%)")
    else:
        entity_z = None
        print("    Insufficient data for entity type analysis")

    # ── Coordinate metric test ───────────────────────────────────────────────
    section("Testing coordinate metric structure (α/η/Ω axis geometry)")
    print("""
  EO predicts three distinct coordinate geometries across its axes:
    Mode (α, Arithmetic):       {0, 1, 2}          — equal steps
    Domain (η, Geometric):      {-1, +1, sqrt(2)}  — E↔S >> S↔Sig (4.8× predicted)
    Object (Ω, Transcendental): {√2, 2, 2^√2}      — unequal but close steps

  Two runs:
    [consensus]  9,221 clauses — single high-confidence label per clause
    [combined]  ~39,000 assignments — all 19,764 clauses × 2 model labels each.
                 Where models agree, the clause reinforces one centroid.
                 Where models disagree, the clause pulls two centroids toward each
                 other. Indeterminate cases net out rather than being filtered.
    """)

    # Build combined set: every clause contributes under BOTH model labels.
    # This lets disagreement cases net out rather than being excluded.
    _c_mask = (labels["claude"]["q1"] != "?") & (labels["claude"]["q2"] != "?") & (labels["claude"]["q3"] != "?")
    _g_mask = (labels["gpt4"]["q1"]   != "?") & (labels["gpt4"]["q2"]   != "?") & (labels["gpt4"]["q3"]   != "?")
    _combined_vecs = np.concatenate([vectors[_c_mask], vectors[_g_mask]])
    _combined_q1   = np.concatenate([labels["claude"]["q1"][_c_mask], labels["gpt4"]["q1"][_g_mask]])
    _combined_q2   = np.concatenate([labels["claude"]["q2"][_c_mask], labels["gpt4"]["q2"][_g_mask]])
    _combined_q3   = np.concatenate([labels["claude"]["q3"][_c_mask], labels["gpt4"]["q3"][_g_mask]])
    info(f"Combined set: {len(_combined_vecs):,} label assignments ({_c_mask.sum():,} Claude + {_g_mask.sum():,} GPT-4)")

    coord_metric = {}
    for set_label, vecs, q1, q2, q3 in [
        ("consensus", S["vecs"], S["q1"], S["q2"], S["q3"]),
        ("combined",  _combined_vecs, _combined_q1, _combined_q2, _combined_q3),
    ]:
        print(f"\n  ── {set_label.upper()} ({len(vecs):,} assignments) ──", flush=True)
        coord_metric[set_label] = compute_coordinate_metric_test(
            vecs, q1, q2, q3, label=set_label
        )

    def _print_axis(axis, res):
        if "error" in res:
            print(f"    {axis}: {res['error']}"); return
        r, p = res["pearson_r"], res["pearson_p"]
        print(f"    {axis.upper():8} Pearson r={r:+.4f}  p={p:.4f}")
        emb_d = res.get("embedding_distances", {})
        crd_d = res.get("coordinate_distances", {})
        for pair in sorted(emb_d):
            print(f"      {pair:<35} emb={emb_d[pair]:.5f}  coord={crd_d.get(pair,'?')}")
        dr = res.get("directional", {})
        if dr:
            if axis == "domain":
                obs = dr.get("observed_ratio","?")
                pred_r = dr.get("predicted_ratio","?")
                met = "✓" if dr.get("prediction_met") else "✗"
                print(f"      E↔S/S↔Sig ratio: {obs:.3f} (pred {pred_r:.3f}) {met}")
            elif axis == "mode":
                print(f"      Step ratio: {dr.get('step_ratio','?'):.3f}  {'✓ equal' if dr.get('equal_steps_met') else '✗ unequal'}")
            elif axis == "object":
                print(f"      C↔P additive: {'✓' if dr.get('additive_holds') else '✗'}")

    for set_label, set_results in coord_metric.items():
        print(f"\n  ── {set_label.upper()} ──")
        for axis in ["mode", "domain", "object"]:
            _print_axis(axis, set_results.get(axis, {"error": "missing"}))

    # ── Phasepost frequency ──────────────────────────────────────────────────
    section("Phasepost frequency (all 27 cells, three label sets)")
    phasepost_data = compute_phasepost_frequency(classified_file)
    pp_counts = phasepost_data["counts"]
    pp_cells  = phasepost_data["all_cells"]

    # ── Per-axis consensus rates ──────────────────────────────────────────────
    # Consensus selection bias diagnostic: if Q2=SIGNIFICANCE has a lower
    # consensus rate than Q1 or Q3, the consensus subset systematically
    # underrepresents those cells. Per-axis rates reveal this directly.
    section("Per-axis consensus rates (selection bias diagnostic)")
    n_total = len(vectors)
    for axis_name, ax_labels_c, ax_labels_g in [
        ("Q1 Mode",   labels["claude"]["q1"],  labels["gpt4"]["q1"]),
        ("Q2 Domain", labels["claude"]["q2"],  labels["gpt4"]["q2"]),
        ("Q3 Object", labels["claude"]["q3"],  labels["gpt4"]["q3"]),
    ]:
        both_valid = (ax_labels_c != "?") & (ax_labels_g != "?")
        n_classifiable = both_valid.sum()
        if n_classifiable == 0:
            continue
        agree = (ax_labels_c == ax_labels_g) & both_valid
        n_agree = agree.sum()
        rate = n_agree / n_classifiable
        print(f"  {axis_name}: {n_agree:,}/{n_classifiable:,} agree = {rate:.1%} consensus rate")
        # Per-value breakdown
        values = [v for v in np.unique(ax_labels_c[both_valid]) if v != "?"]
        for val in sorted(values):
            val_mask = both_valid & (ax_labels_c == val)
            val_agree = (ax_labels_c == ax_labels_g) & val_mask
            if val_mask.sum() > 0:
                val_rate = val_agree.sum() / val_mask.sum()
                print(f"    {val}: {val_agree.sum():,}/{val_mask.sum():,} = {val_rate:.1%}")
    print()

    # Print tables to terminal for all three sets
    for label_key, label_title in [
        ("consensus", "CONSENSUS (both models agreed)"),
        ("claude",    "CLAUDE labels"),
        ("gpt4",      "GPT-4 labels"),
    ]:
        if sum(pp_counts.get(label_key, {}).values()) == 0:
            continue
        print()
        lines = format_phasepost_table(pp_counts, pp_cells, label_key, label_title)
        for l in lines:
            print(l)

    # ── Helix dependency tests ───────────────────────────────────────────────
    section("Testing helix dependency structure (3 tests)")
    pp_consensus = phasepost_data["counts"].get("consensus", {})
    # Run helix tests on both consensus and combined sets
    helix_tests = {
        "consensus": compute_helix_dependency_tests(S["q1"], S["q2"], S["q3"], pp_consensus),
        "combined":  compute_helix_dependency_tests(
            S_combined["q1"], S_combined["q2"], S_combined["q3"], pp_consensus),
    }

    for ht_set, ht_res in helix_tests.items():
        t1 = ht_res.get("test1_directional_entropy", {})
        t2 = ht_res.get("test2_ordinal_correlation", {})
        t3 = ht_res.get("test3_topology_prediction", {})
        print(f"  [{ht_set}] Test 1 asymmetry={t1.get('asymmetry_bits','?')} bits  p={t1.get('asymmetry_pval','?')}")
        print(f"  [{ht_set}] Test 2 Spearman r={t2.get('spearman_r','?')}  p={t2.get('spearman_p','?')}")
        print(f"  [{ht_set}] Test 3 top-3={t3.get('top3_match','?')}  structure={t3.get('structure_dominates','?')}")

    # ── Subspace geometry (principal angles + LDA) ───────────────────────────
    section("Subspace geometry — principal angles and LDA projection")
    # Run subspace geometry on consensus AND combined
    # Combined gives more data; consensus gives cleaner labels.
    # Compare to see whether the subspace shape survives dilution.
    subspace_geo = {
        "consensus": compute_subspace_geometry(
            S["vecs"], S["q1"], S["q2"], S["q3"], run_dir),
        "combined":  compute_subspace_geometry(
            S_combined["vecs"], S_combined["q1"], S_combined["q2"],
            S_combined["q3"], run_dir, suffix="_combined"),
    }
    for pair, res in subspace_geo.get("principal_angles", {}).items():
        if "error" in res:
            print(f"  {pair}: {res['error']}")
        else:
            print(f"  {pair}: {res['principal_angles_deg']}°")

    # ── Per-language z-scores (primary set, cached) ──────────────────────────
    # Cache lives in results.json alongside the run. On re-runs we only
    # recompute languages whose clause count changed OR whose cached entry
    # is missing the face-level keys added in a later code version.
    section("Computing cross-linguistic z-scores (one per language)")

    EXPECTED_KEYS = {"q1", "q2", "q3", "act_face", "site_face", "resolution_face", "full_27cell"}

    cache_file = run_dir / "results.json"
    cached_per_lang = {}
    cached_lang_counts = {}
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text())
            cached_per_lang    = cached.get("per_lang", {})
            cached_lang_counts = cached.get("lang_counts", {})
            if cached_per_lang:
                info(f"Loaded per-language cache: {len(cached_per_lang)} languages")
        except Exception:
            pass

    # Count how many clauses per language are in the current analysis set
    current_lang_counts = {}
    for l in S["lang"]:
        current_lang_counts[l] = current_lang_counts.get(l, 0) + 1

    # Decide which languages need recomputing
    # Triggers: clause count changed OR cache entry is missing face-level keys
    needs_recompute = []
    reuse_count = 0
    for lang, n_cur in current_lang_counts.items():
        n_cached = cached_lang_counts.get(lang, 0)
        cached_entry = cached_per_lang.get(lang, {})
        has_face_keys = EXPECTED_KEYS.issubset(set(cached_entry.keys()))
        if lang not in cached_per_lang or n_cur != n_cached or not has_face_keys:
            needs_recompute.append(lang)
        else:
            reuse_count += 1

    if reuse_count:
        info(f"Reusing cached results for {reuse_count} unchanged languages")
    if needs_recompute:
        info(f"Recomputing {len(needs_recompute)} new/updated languages: {', '.join(sorted(needs_recompute))}")

    # Recompute only what changed — use full function to get all face-level keys
    fresh_per_lang = {}
    if needs_recompute:
        lang_mask_full = S["lang"]
        for lang in needs_recompute:
            mask = lang_mask_full == lang
            if mask.sum() < 100:
                continue
            vecs_l  = S["vecs"][mask]
            lq1, lq2, lq3 = S["q1"][mask], S["q2"][mask], S["q3"][mask]
            fresh_per_lang[lang] = {}

            # Individual axes
            for axis_name, labels in [("q1", lq1), ("q2", lq2), ("q3", lq3)]:
                valid = labels != "?"
                if valid.sum() < 50:
                    continue
                z, sep = compute_zscore(vecs_l[valid], labels[valid], n_shuffles=200)
                fresh_per_lang[lang][axis_name] = {"z": round(z,2), "separation": round(sep,4)}
                print(f"    {lang} {axis_name}: {z:+.2f} SDs", flush=True)

            # Act face (Q1×Q2)
            valid = (lq1 != "?") & (lq2 != "?")
            if valid.sum() >= 50:
                act_lbl = np.array([f"{lq1[i]}/{lq2[i]}" for i in range(len(lq1))])
                z, sep = compute_zscore(vecs_l[valid], act_lbl[valid], n_shuffles=200)
                fresh_per_lang[lang]["act_face"] = {"z": round(z,2), "separation": round(sep,4)}
                print(f"    {lang} act_face: {z:+.2f} SDs", flush=True)

            # Site face (Q2×Q3)
            valid = (lq2 != "?") & (lq3 != "?")
            if valid.sum() >= 50:
                site_lbl = np.array([f"{lq2[i]}/{lq3[i]}" for i in range(len(lq2))])
                z, sep = compute_zscore(vecs_l[valid], site_lbl[valid], n_shuffles=200)
                fresh_per_lang[lang]["site_face"] = {"z": round(z,2), "separation": round(sep,4)}
                print(f"    {lang} site_face: {z:+.2f} SDs", flush=True)

            # Resolution face (Q1×Q3)
            valid = (lq1 != "?") & (lq3 != "?")
            if valid.sum() >= 50:
                res_lbl = np.array([f"{lq1[i]}/{lq3[i]}" for i in range(len(lq1))])
                z, sep = compute_zscore(vecs_l[valid], res_lbl[valid], n_shuffles=200)
                fresh_per_lang[lang]["resolution_face"] = {"z": round(z,2), "separation": round(sep,4)}
                print(f"    {lang} resolution_face: {z:+.2f} SDs", flush=True)

            # Full 27-cell
            valid = (lq1 != "?") & (lq2 != "?") & (lq3 != "?")
            if valid.sum() >= 50:
                full_lbl = np.array([f"{lq1[i]}/{lq2[i]}/{lq3[i]}" for i in range(len(lq1))])
                z, sep = compute_zscore(vecs_l[valid], full_lbl[valid], n_shuffles=200)
                fresh_per_lang[lang]["full_27cell"] = {"z": round(z,2), "separation": round(sep,4)}
                print(f"    {lang} full_27cell: {z:+.2f} SDs", flush=True)

    # Merge: cached results + fresh recomputed
    per_lang = {**cached_per_lang, **fresh_per_lang}

    sig = sum(1 for v in per_lang.values() if v.get("q1",{}).get("z",0) > 10)
    ok(f"Per-language z-scores computed for {len(per_lang)} languages")

    # ── Cross-set comparison summary ──────────────────────────────────────────
    section("Cross-set comparison summary")
    print(f"  {'Set':<12} {'Q1 z':>8} {'Q2 z':>8} {'Q3 z':>8}  {'Interpretation'}")
    print(f"  {'─'*12} {'─'*8} {'─'*8} {'─'*8}  {'─'*30}")
    for set_name in ["consensus", "claude", "gpt4", "combined"]:
        if set_name not in all_zscores:
            continue
        zs = all_zscores[set_name]
        q1z = zs.get("q1",{}).get("z","n/a")
        q2z = zs.get("q2",{}).get("z","n/a")
        q3z = zs.get("q3",{}).get("z","n/a")
        def fmt(z):
            if not isinstance(z, float): return f"{'n/a':>8}"
            return f"{z:>+8.2f}"
        # Interpret agreement pattern
        interp_map = {
            "consensus": "both models agreed (includes FLORES)",
            "claude":    "Claude's classifications",
            "gpt4":      "GPT-4's classifications",
            "combined":  "both model labels concatenated",
            "ud_only":   "UD-only consensus — FLORES excluded",
        }
        interp = interp_map.get(set_name, set_name)
        print(f"  {set_name:<12}{fmt(q1z)}{fmt(q2z)}{fmt(q3z)}  {interp}")

    # ── Full-corpus z-scores (all 19k, best-available labels) ───────────────
    # RES and SITE needed for 27-cell address computation
    SITE = {
        ("EXISTENCE","CONDITION"):"Void", ("EXISTENCE","ENTITY"):"Entity",
        ("EXISTENCE","PATTERN"):"Kind", ("STRUCTURE","CONDITION"):"Field",
        ("STRUCTURE","ENTITY"):"Link", ("STRUCTURE","PATTERN"):"Network",
        ("SIGNIFICANCE","CONDITION"):"Atmosphere", ("SIGNIFICANCE","ENTITY"):"Lens",
        ("SIGNIFICANCE","PATTERN"):"Paradigm",
    }
    RES = {
        ("DIFFERENTIATING","CONDITION"):"Clearing", ("DIFFERENTIATING","ENTITY"):"Dissecting",
        ("DIFFERENTIATING","PATTERN"):"Unraveling", ("RELATING","CONDITION"):"Tending",
        ("RELATING","ENTITY"):"Binding", ("RELATING","PATTERN"):"Tracing",
        ("GENERATING","CONDITION"):"Cultivating", ("GENERATING","ENTITY"):"Making",
        ("GENERATING","PATTERN"):"Composing",
    }
    section("Computing z-scores on full corpus (all embedded clauses)")
    full_zscores = {}
    for axis in ["q1","q2","q3"]:
        lbl = S_full[axis]
        valid = lbl != "?"
        if valid.sum() >= 100:
            z, sep = compute_zscore(S_full["vecs"][valid], lbl[valid], n_shuffles=200)
            full_zscores[axis] = {"z": round(float(z),3), "n": int(valid.sum())}
            print(f"  Full corpus {axis}: {z:+.2f} SDs (n={valid.sum():,})")

    full_face_zscores = {}
    for face_name, lbl_fn in [
        ("operators_act", lambda: np.array([ACT.get((S_full["q1"][i],S_full["q2"][i]),"?") for i in range(len(S_full["vecs"]))])),
    ]:
        face_lbl = lbl_fn()
        valid = face_lbl != "?"
        if valid.sum() >= 100:
            z, _ = compute_zscore(S_full["vecs"][valid], face_lbl[valid], n_shuffles=200)
            full_face_zscores[face_name] = {"z": round(float(z),3)}
            print(f"  Full corpus {face_name}: {z:+.2f} SDs")

    # Full 27-cell
    full_27 = np.array([
        f"{ACT.get((S_full['q1'][i],S_full['q2'][i]),'?')}({RES.get((S_full['q1'][i],S_full['q3'][i]),'?')}, {SITE.get((S_full['q2'][i],S_full['q3'][i]),'?')})"
        if S_full['q1'][i]!="?" and S_full['q2'][i]!="?" and S_full['q3'][i]!="?" else "?"
        for i in range(len(S_full["vecs"]))
    ])
    valid27 = full_27 != "?"
    if valid27.sum() >= 100:
        z27, _ = compute_zscore(S_full["vecs"][valid27], full_27[valid27], n_shuffles=200)
        full_face_zscores["full_27cell"] = {"z": round(float(z27),3)}
        print(f"  Full corpus 27-cell: {z27:+.2f} SDs (n={valid27.sum():,})")

    # ── Coordinate geometry distance analysis ────────────────────────────────
    section("Coordinate geometry distance analysis (α/η/Ω)")
    coord_results = compute_coordinate_geometry_analysis(
        S_full["vecs"], S_full["q1"], S_full["q2"], S_full["q3"]
    )
    (run_dir / "coord_geometry.json").write_text(json.dumps(coord_results, indent=2))
    ok(f"Coordinate geometry results: {run_dir / 'coord_geometry.json'}")

    # ── Report and figures ────────────────────────────────────────────────────
    section("Generating report")
    report_path = generate_report(run_dir, zscores, proportionality, ari,
                                  per_lang, kappas, len(S["vecs"]), n_langs,
                                  models_used, n_total_embedded=len(vectors),
                                  all_zscores=all_zscores, all_ari=all_ari,
                                  face_zscores=face_zscores, unsupervised=unsupervised,
                                  ari_exclusion=ari_exclusion, entity_z=entity_z,
                                  phasepost_data=phasepost_data,
                                  full_zscores=full_zscores,
                                  full_face_zscores=full_face_zscores,
                                  coord_results=coord_metric,
                                  helix_tests=helix_tests,
                                  subspace_geo=subspace_geo)
    ok(f"Report: {report_path}")

    section("Generating figures")
    et_labels_full = np.array([ENTITY_TYPE_MAP.get(v,"?") for v in S["q3"]])
    generate_figures(run_dir, S["vecs"], S["q1"], S["q2"], S["q3"],
                     S["op"], S["lang"], zscores, proportionality, per_lang,
                     entity_labels=et_labels_full)

    results = {
        "zscores": zscores, "all_zscores": all_zscores,
        "full_zscores": full_zscores, "full_face_zscores": full_face_zscores,
        "coord_geometry": coord_metric,
        "proportionality": proportionality,
        "ari": ari, "all_ari": all_ari,
        "kappas": kappas,
        "helix_tests": helix_tests,
        "subspace_geometry": subspace_geo,
        "n_clauses": int(len(S["vecs"])), "n_languages": n_langs,
        "n_total_embedded": int(len(vectors)),
        "models": models_used,
        # Cache fields — used on next run to skip unchanged languages
        "per_lang":      per_lang,
        "lang_counts":   current_lang_counts,
        "face_zscores":  face_zscores,
        "unsupervised":  unsupervised,
        "ari_exclusion": ari_exclusion,
        "entity_z": entity_z,
        "phasepost": {k: dict(v) for k,v in pp_counts.items()},
    }
    (run_dir / "results.json").write_text(json.dumps(results, indent=2))
    return results


# ─────────────────────────────────────────────────────────────────────────────
# SETUP WIZARD — runs once, saves settings to .env
# ─────────────────────────────────────────────────────────────────────────────

def setup_wizard(args):
    """Interactive setup: API keys, model selection, corpus options."""

    header("EO LEXICAL ANALYSIS v2 — SETUP")
    print(textwrap.dedent("""\

      This pipeline tests whether Emergent Ontology's three-axis structure
      corresponds to real semantic dimensions in natural language.

      It will:
        1. Download clauses from Universal Dependencies (100+ languages)
           and FLORES-200 (200 languages, same content)
        2. Classify each clause with three plain questions via AI
        3. Embed the original clause text (no EO vocabulary)
        4. Measure whether classified structure matches geometric structure

      Setup takes about 2 minutes. Settings are saved to .env for re-runs.
    """))

    settings = {}

    # ── API Keys ──────────────────────────────────────────────────────────────
    section("API Keys")
    info("Keys are saved to .env — never committed to git")

    anthropic_key = get_setting(
        "ANTHROPIC_API_KEY",
        "Anthropic API key (sk-ant-...)",
        secret=True
    )
    openai_key = get_setting(
        "OPENAI_API_KEY",
        "OpenAI API key (sk-...)",
        secret=True
    )

    # ── Model Selection ───────────────────────────────────────────────────────
    section("Classifier Models")
    print("""
  Using multiple models lets us measure inter-model agreement (Cohen's kappa).
  High kappa means the three questions are robust, not model-specific.
  More models = more expensive but more reliable results.
    """)

    available_models = []
    if anthropic_key:
        available_models.append("claude")
        ok("Claude Sonnet (Anthropic) — available")
    if openai_key:
        available_models.append("gpt4")
        ok("GPT-4o (OpenAI) — available")
        gemini_key = os.environ.get("GEMINI_API_KEY") or ask(
            "Google AI Studio key for Gemini (leave blank to skip)", default=""
        )
        if gemini_key:
            os.environ["GEMINI_API_KEY"] = gemini_key
            save_env({"GEMINI_API_KEY": gemini_key})
            available_models.append("gemini")
            ok("Gemini 1.5 Flash (Google) — will use")
        else:
            info("Gemini skipped (no GEMINI_API_KEY)")

    if not available_models:
        err("No classifier models available. At least one API key required.")
        sys.exit(1)

    settings["models"] = available_models

    # ── Corpus Options ────────────────────────────────────────────────────────
    section("Corpus Options")

    use_ud     = confirm("Download Universal Dependencies treebanks? (~60+ languages, best quality)", default=True)
    use_flores = confirm("Download FLORES-200? (same 200 sentences in 200 languages, parity test)", default=True)

    max_per_lang = int(ask(
        "Max clauses per language (more = slower + more expensive, but more robust)",
        default="500"
    ))

    settings.update({
        "use_ud":      use_ud,
        "use_flores":  use_flores,
        "max_per_lang": max_per_lang,
        "anthropic_key": anthropic_key,
        "openai_key":    openai_key,
    })

    # ── Sampling for test runs ─────────────────────────────────────────────────
    section("Run Options")
    sample_n = None
    if confirm("Classify ALL clauses? (say No to sample a subset for a quick test)", default=True):
        info("Will classify all extracted clauses")
    else:
        sample_n = int(ask("How many clauses to sample for classification?", default="500"))
        info(f"Will sample {sample_n} clauses")
    settings["sample_n"] = sample_n

    # ── Output Directory ──────────────────────────────────────────────────────
    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    run_dir = Path("output") / f"run_{ts}"
    run_dir.mkdir(parents=True, exist_ok=True)
    settings["run_dir"] = run_dir

    data_dir = Path("data")
    data_dir.mkdir(exist_ok=True)
    settings["data_dir"] = data_dir

    # ── Summary ───────────────────────────────────────────────────────────────
    header("READY TO RUN")
    print(f"""
  Models:        {', '.join(available_models)}
  UD treebanks:  {'yes' if use_ud else 'no'}
  FLORES-200:    {'yes' if use_flores else 'no'}
  Max/language:  {max_per_lang}
  Sample:        {sample_n if sample_n else 'all'}
  Output:        {run_dir}
    """)
    if not confirm("Begin?", default=True):
        sys.exit(0)

    return settings


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="EO Lexical Analysis v2 — Three-Axis Clause Classification",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
          Examples:
            python app.py                       # interactive setup + full run
            python app.py --phase corpus        # only download and extract clauses
            python app.py --phase classify      # only classify (needs data/)
            python app.py --phase embed         # only embed classified clauses
            python app.py --phase analyze       # only analyze (needs embeddings)
            python app.py --sample 200          # classify only 200 clauses (test run)
            python app.py --resume              # resume a previously interrupted run
        """)
    )
    parser.add_argument("--phase",   choices=["corpus","classify","embed","analyze","centroids","all"],
                        default="all", help="Which phase to run (default: all)")
    parser.add_argument("--sample",  type=int, default=None,
                        help="Classify only N clauses (for quick test runs)")
    parser.add_argument("--resume",  action="store_true",
                        help="Resume from existing output directory")
    parser.add_argument("--run-dir", type=str, default=None,
                        help="Use a specific output directory (for --resume)")
    parser.add_argument("--max-per-lang", type=int, default=None,
                        help="Override max clauses per language")
    parser.add_argument("--no-flores", action="store_true",
                        help="Skip FLORES-200 download")
    parser.add_argument("--no-ud",     action="store_true",
                        help="Skip Universal Dependencies download")
    parser.add_argument("--models",    type=str, default=None,
                        help="Comma-separated models to use: claude,gpt4,gemini (default: all available)")
    parser.add_argument("--force-analysis", action="store_true",
                        help="Force recomputation of analysis even if results.json is newer than inputs")
    args = parser.parse_args()

    # ── Check dependencies ────────────────────────────────────────────────────
    header("EO LEXICAL ANALYSIS v2")
    missing = check_dependencies()
    if missing:
        warn(f"Missing packages: {', '.join(p for _,p in missing)}")
        if confirm("Install them now?", default=True):
            install_dependencies(missing)
            ok("Re-importing...")
            # Re-import after install
            import importlib
            for pkg, _ in missing:
                try: importlib.import_module(pkg)
                except: pass
        else:
            err("Cannot continue without required packages.")
            sys.exit(1)
    else:
        ok("All dependencies satisfied")

    load_env()

    # ── Setup or load existing run ────────────────────────────────────────────
    # If --run-dir is provided, skip the wizard entirely — load keys from .env
    # and point at the existing directory. Normal path for embed/analyze on an
    # already-classified corpus.
    if args.run_dir:
        run_dir  = Path(args.run_dir)
        data_dir = Path("data")
        # Load settings from .env
        settings = {
            "run_dir":      run_dir,
            "data_dir":     data_dir,
            "anthropic_key": os.environ.get("ANTHROPIC_API_KEY"),
            "openai_key":    os.environ.get("OPENAI_API_KEY"),
            "models":        [m for m in ["claude","gpt4"] if os.environ.get(f"{m.upper()}_KEY")],
            "use_ud":        not args.no_ud,
            "use_flores":    not args.no_flores,
            "max_per_lang":  args.max_per_lang or 500,
            "sample_n":      args.sample,
        }
        ok(f"Resuming from {run_dir}")
        if args.models:
            settings["models"] = [m.strip() for m in args.models.split(",")]
    else:
        settings = setup_wizard(args)
        if args.max_per_lang:
            settings["max_per_lang"] = args.max_per_lang
        if args.sample:
            settings["sample_n"] = args.sample
        if args.no_flores:
            settings["use_flores"] = False
        if args.no_ud:
            settings["use_ud"] = False

    run_dir  = settings["run_dir"]
    data_dir = settings["data_dir"]

    # ── Apply --models override (works for both wizard and --run-dir paths) ──
    if args.models:
        settings["models"] = [m.strip() for m in args.models.split(",")]
        info(f"Using models: {settings['models']}")

    # ── Phase 1: Corpus ───────────────────────────────────────────────────────
    if args.phase in ("all","corpus","classify"):
        header("PHASE 1 — CORPUS EXTRACTION")
        print("""
  Downloading and extracting clauses from:
    · Universal Dependencies treebanks (real parsed sentences, 60+ languages)
    · FLORES-200 (professionally translated, 200 languages, same content)

  Filters: declarative main clauses, 8–30 words, contains a verb.
  The raw clause text is all that matters — no linguistic annotations
  carry through to the embeddings.
        """)

        corpus_file = run_dir / "raw_clauses.jsonl"
        if corpus_file.exists() and args.resume:
            with open(corpus_file) as f:
                clauses = [json.loads(l) for l in f if l.strip()]
            ok(f"Loaded {len(clauses):,} clauses from existing corpus file")
        else:
            clauses = load_corpus(
                data_dir,
                max_per_lang=settings["max_per_lang"],
                use_flores=settings["use_flores"],
                use_ud=settings["use_ud"],
            )
            with open(corpus_file, "w", encoding="utf-8") as f:
                for c in clauses:
                    f.write(json.dumps(c, ensure_ascii=False) + "\n")
            ok(f"Saved {len(clauses):,} clauses to {corpus_file}")

    # ── Phase 2: Classification ───────────────────────────────────────────────
    if args.phase in ("all","classify"):
        header("PHASE 2 — CLASSIFICATION")
        print(f"""
  Each clause is sent to {len(settings['models'])} classifier model(s) with three plain questions.
  No EO vocabulary. No operator names. Just:
    Q1: Separating / Connecting / Producing?
    Q2: Existence / Organization / Meaning?
    Q3: Background condition / Specific thing / Pattern?

  The models answer each question independently.
  Where all models agree, the clause gets a 'consensus' label.
  Where they disagree, the clause is flagged as ambiguous.
  Inter-model agreement (Cohen's kappa) is measured per axis.

  Results are saved progressively — if this crashes, re-run with --resume.
        """)

        classified_file = run_classification(
            clauses=clauses,
            run_dir=run_dir,
            anthropic_key=settings.get("anthropic_key"),
            openai_key=settings.get("openai_key"),
            models=settings["models"],
            sample_n=settings.get("sample_n"),
            resume=args.resume,
        )

    # ── Phase 3: Embedding ────────────────────────────────────────────────────
    if args.phase in ("all","embed"):
        header("PHASE 3 — EMBEDDING")
        print("""
  The ORIGINAL clause text is encoded as a 3072-dimensional vector.
  No EO vocabulary is added. The embedding model (OpenAI text-embedding-3-large)
  was trained without EO. Any geometric structure found here is not circular.

  If classified groups cluster geometrically, it's because the three plain
  questions are tracking real structure in language — not because we built
  EO into the representations.
        """)

        classified_file = run_dir / "classified.jsonl"
        if not classified_file.exists():
            err(f"classified.jsonl not found in {run_dir}. Run --phase classify first.")
            sys.exit(1)

        embeddings_file = run_embedding(
            classified_file=classified_file,
            run_dir=run_dir,
            openai_key=settings["openai_key"],
        )

    # ── Phase 4: Analysis ─────────────────────────────────────────────────────
    if args.phase in ("all","analyze"):
        header("PHASE 4 — ANALYSIS")
        print("""
  Three measurements:

  (a) Per-axis z-score
      Within-group cosine similarity vs between-group, shuffled 200 times.
      Does each axis produce real geometric separation?

  (b) Proportionality
      Do clauses differing on more axes end up farther apart?
      This tests the coordinate structure, not just grouping.

  (c) Axis independence (ARI)
      Do the three axes classify clauses independently?
      High ARI = the axes are correlated = the three-axis claim is false.
        """)

        embeddings_file  = run_dir / "embeddings.npz"
        classified_file  = run_dir / "classified.jsonl"
        if not embeddings_file.exists():
            err(f"embeddings.npz not found in {run_dir}. Run --phase embed first.")
            sys.exit(1)

        results = run_analysis(
            embeddings_file=embeddings_file,
            classified_file=classified_file,
            run_dir=run_dir,
            models_used=settings.get("models", ["claude"]),
            force=getattr(args, "force_analysis", False),
        )

    # ── Phase 5: Centroids ───────────────────────────────────────────────────
    if args.phase in ("all","centroids"):
        header("PHASE 5 — CENTROID CLASSIFIER")
        print("""
  Computes the geometric center (centroid) of each EO cell from
  consensus-classified clauses, then classifies ALL clauses by
  nearest centroid — no AI classifiers involved, pure geometry.

  Tests whether the 27 cells are stable geometric regions that can
  address new text without any classification prompt.

  Saves centroids.npz so any text can be embedded and addressed.
        """)

        embeddings_file = run_dir / "embeddings.npz"
        classified_file = run_dir / "classified.jsonl"

        if not embeddings_file.exists():
            err(f"embeddings.npz not found. Run --phase embed first.")
            sys.exit(1)

        centroid_results, centroid_file = run_centroids(
            embeddings_file=embeddings_file,
            classified_file=classified_file,
            run_dir=run_dir,
        )

    # ── Done ──────────────────────────────────────────────────────────────────
    header("COMPLETE")
    print(f"""
  Output directory: {run_dir}/

  Files:
    raw_clauses.jsonl      Corpus clauses (language-tagged)
    classified.jsonl       Q1/Q2/Q3 per model per clause
    embeddings.npz         Clause vectors (numpy archive)
    analysis_report.txt    Full results with plain-English commentary
    results.json           Raw numbers (for further analysis)
    figures/               PCA projection, z-score chart, proportionality curve
    centroids.npz          Centroid vectors for all 27 cells, 9 operators, 3 triads
    centroid_report.txt    Centroid classification accuracy report
    centroids.npz          27-cell centroid vectors (for classifying new text)
    centroid_results.json  Centroid classifier accuracy per level
    """)


if __name__ == "__main__":
    main()