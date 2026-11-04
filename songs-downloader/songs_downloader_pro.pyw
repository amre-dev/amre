# -*- coding: utf-8 -*-
"""
تنزيل الأغاني Pro
-----------------
- واجهة customtkinter (وضع داكن/فاتح)
- غلاف الأغنية (thumbnail): تحويل لـ jpg + قص مربع + تضمين داخل الملف + معاينة بكل صف
- قوائم التشغيل تتفكك لصفوف مستقلة (لكل أغنية صفها وغلافها وتقدمها)
- شريط تقدم لكل صف، إلغاء، إعادة محاولة، فتح موقع الملف
- سجل تنزيلات لتخطي المكرر، حفظ الإعدادات، مراقبة الحافظة، تحديث yt-dlp

التثبيت:  pip install -U yt-dlp customtkinter pillow mutagen
وكمان ffmpeg:  winget install ffmpeg
"""
import io
import os
import re
import sys
import json
import queue
import shutil
import logging
import threading
import subprocess
import time
import urllib.request
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor
import tkinter as tk
from tkinter import messagebox, filedialog

# ====================== مسارات وسجل أخطاء ======================
APP_NAME = "SongsDownloader"
FOLDER_NAME = "الأغاني"
CONFIG_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), APP_NAME)
os.makedirs(CONFIG_DIR, exist_ok=True)
CONFIG_FILE = os.path.join(CONFIG_DIR, "settings.json")
ARCHIVE_FILE = os.path.join(CONFIG_DIR, "archive.txt")
LOG_FILE = os.path.join(CONFIG_DIR, "app.log")

logging.basicConfig(
    filename=LOG_FILE, level=logging.INFO, encoding="utf-8",
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(APP_NAME)


def fatal(msg):
    """ملف .pyw ما بيطلّع نافذة أخطاء، فنعرض رسالة بدالها."""
    try:
        r = tk.Tk()
        r.withdraw()
        messagebox.showerror("خطأ", msg)
        r.destroy()
    except Exception:
        pass
    sys.exit(1)


def _excepthook(exc_type, exc, tb):
    log.error("Uncaught exception", exc_info=(exc_type, exc, tb))


sys.excepthook = _excepthook

# ====================== المكتبات المطلوبة ======================
_missing = []
try:
    import yt_dlp
except ImportError:
    _missing.append("yt-dlp")
try:
    import customtkinter as ctk
except ImportError:
    _missing.append("customtkinter")
try:
    from PIL import Image
except ImportError:
    _missing.append("pillow")
if _missing:
    fatal("مكتبات ناقصة.\nافتح PowerShell ونفّذ:\npip install -U " + " ".join(_missing) + " mutagen")

try:
    import mutagen  # noqa: F401  (يحتاجها yt-dlp لتضمين الغلاف بـ flac)
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

_Cancelled = type("_Cancelled", (Exception,), {})
CancelExc = getattr(yt_dlp.utils, "DownloadCancelled", _Cancelled)

# ====================== الإعدادات ======================
FORMATS = {
    "mp3": {"kind": "audio", "codec": "mp3"},
    "m4a": {"kind": "audio", "codec": "m4a"},
    "flac": {"kind": "audio", "codec": "flac"},
    "mp4 فيديو": {"kind": "video", "codec": "mp4"},
}
QUALITIES = ["128", "192", "256", "320"]
CLIP_HOSTS = ("youtube.com", "youtu.be", "soundcloud.com", "bandcamp.com")
COVER_PREVIEW = 64   # حجم معاينة الغلاف بالصف (بكسل)


def get_desktop():
    """يجيب مسار سطح المكتب الحقيقي (حتى لو مربوط بـ OneDrive)."""
    try:
        import ctypes
        FOLDERID_Desktop = ctypes.c_char_p(
            b"\x3a\xcc\xbf\xb4\x2c\xdb\x4c\x42\xb0\x29\x7f\xe9\x9a\x87\xc6\x41"
        )
        path_ptr = ctypes.c_wchar_p()
        res = ctypes.windll.shell32.SHGetKnownFolderPath(FOLDERID_Desktop, 0, None, ctypes.byref(path_ptr))
        if res == 0 and path_ptr.value:
            return path_ptr.value
    except Exception:
        pass
    home = os.path.expanduser("~")
    for p in (os.path.join(home, "Desktop"), os.path.join(home, "OneDrive", "Desktop")):
        if os.path.isdir(p):
            return p
    return home


DEFAULTS = {
    "save_dir": os.path.join(get_desktop(), FOLDER_NAME),
    "format": "mp3",
    "quality": "192",
    "parallel": 3,
    "embed_thumb": True,      # تضمين الغلاف داخل الملف
    "crop_square": True,      # قص الغلاف مربع من المنتصف (مثل ألبومات الموسيقى)
    "use_archive": True,      # تخطي الأغاني المنزّلة سابقاً
    "watch_clipboard": False, # تنزيل تلقائي لأي رابط يوتيوب ينسخه المستخدم
    "theme": "dark",
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        for k in DEFAULTS:
            if k in saved:
                cfg[k] = saved[k]
    except Exception:
        pass
    if cfg["format"] not in FORMATS:
        cfg["format"] = "mp3"
    if cfg["quality"] not in QUALITIES:
        cfg["quality"] = "192"
    try:
        cfg["parallel"] = max(1, min(8, int(cfg["parallel"])))
    except Exception:
        cfg["parallel"] = 3
    return cfg


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("save_config failed")


# ====================== أدوات مساعدة ======================
def safe_name(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    return name[:80] or "playlist"


def short(s, n=80):
    s = s or ""
    return s if len(s) <= n else s[: n - 1] + "…"


def clean_error(e):
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
    msg = msg.replace("ERROR:", "").strip()
    return msg or e.__class__.__name__


def task_outdir(cfg, folder):
    return os.path.join(cfg["save_dir"], folder) if folder else cfg["save_dir"]


def is_single_video(url):
    """رابط فيديو واحد (فيه v= أو youtu.be) حتى لو فيه list= نعتبره فيديو واحد."""
    try:
        p = urlparse(url)
        return "v" in parse_qs(p.query) or p.netloc.lower().endswith("youtu.be")
    except Exception:
        return False


def open_path(path):
    try:
        if os.name == "nt":
            os.startfile(path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        log.exception("open_path failed")


def make_cover(data, size, square):
    """يحوّل بايتات الصورة إلى صورة PIL مربعة للمعاينة."""
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    if square:
        s = min(w, h)
        l, t = (w - s) // 2, (h - s) // 2
        im = im.crop((l, t, l + s, t + s)).resize((size, size), Image.LANCZOS)
    else:
        im.thumbnail((size, size), Image.LANCZOS)
        bg = Image.new("RGB", (size, size), (30, 30, 30))
        bg.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        im = bg
    return im


class QuietLogger:
    """يلتقط رسائل yt-dlp: هل الأغنية مخطّاة (موجودة مسبقاً)؟ وآخر خطأ."""
    def __init__(self):
        self.skipped = False
        self.last_error = ""

    def _check(self, msg):
        if "already been recorded in the archive" in msg or "has already been downloaded" in msg:
            self.skipped = True

    def debug(self, msg):
        self._check(msg)

    def info(self, msg):
        self._check(msg)

    def warning(self, msg):
        log.warning(msg)

    def error(self, msg):
        self.last_error = msg
        log.error(msg)


def build_opts(cfg, folder, logger):
    fmt = FORMATS[cfg["format"]]
    outdir = task_outdir(cfg, folder)
    opts = {
        "outtmpl": os.path.join(outdir, "%(title)s.%(ext)s"),
        "noplaylist": True,          # كل رابط هنا هو أغنية واحدة (القوائم بتتفكك قبل)
        "quiet": True,
        "no_warnings": True,
        "logger": logger,
        "windowsfilenames": True,
        "trim_file_name": 150,
        "retries": 5,
        "fragment_retries": 5,
        "continuedl": True,
    }
    if cfg["use_archive"]:
        opts["download_archive"] = ARCHIVE_FILE

    pps = []
    if fmt["kind"] == "audio":
        opts["format"] = "bestaudio/best"
        pps.append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": fmt["codec"],
            "preferredquality": cfg["quality"],
        })
    else:
        opts["format"] = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"
        opts["merge_output_format"] = "mp4"

    # الترتيب مهم: معلومات الأغنية أولاً ثم الغلاف
    pps.append({"key": "FFmpegMetadata", "add_metadata": True})

    can_embed = cfg["embed_thumb"] and not (cfg["format"] == "flac" and not HAS_MUTAGEN)
    if can_embed:
        opts["writethumbnail"] = True
        # يوتيوب بيعطي webp أحياناً: نحوّله jpg قبل التضمين (متوافق مع كل المشغّلات)
        pps.insert(0, {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"})
        pps.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})
        if cfg["crop_square"]:
            # صورة الفيديو 16:9، وغلاف الأغنية لازم يكون مربع -> قص من المنتصف
            opts["postprocessor_args"] = {
                "thumbnailsconvertor+ffmpeg_o": [
                    "-c:v", "mjpeg", "-q:v", "2",
                    "-vf", "crop='min(iw,ih)':'min(iw,ih)'",
                ]
            }
    opts["postprocessors"] = pps
    return opts


# ====================== مهمة وصف ======================
class Task:
    ACTIVE = ("expanding", "queued", "running")

    def __init__(self, tid, url, folder=None):
        self.tid = tid
        self.url = url
        self.folder = folder
        self.cancel = threading.Event()
        self.future = None
        self.state = "queued"
        self.row = None
        self.path = None
        self.cfg = None
        self.error_full = ""
        self.meta_sent = False

    @property
    def active(self):
        return self.state in self.ACTIVE


# ====================== صف بالقائمة ======================
class Row(ctk.CTkFrame):
    COLORS = {
        "done": "#2fa84f", "skipped": "#8a8f98", "error": "#d64545",
        "cancelled": "#8a8f98", "running": None, "queued": None, "expanding": None,
    }

    def __init__(self, master, app, task, title):
        super().__init__(master, corner_radius=10)
        self.app = app
        self.task = task
        self._img = None
        self.columnconfigure(1, weight=1)

        # الغلاف (يمين)
        self.cover = ctk.CTkLabel(
            self, text="🎵", width=COVER_PREVIEW, height=COVER_PREVIEW,
            fg_color=("#d4d4d4", "#2b2b2b"), corner_radius=8, font=("Segoe UI Emoji", 24),
        )
        self.cover.grid(row=0, column=2, rowspan=3, padx=(6, 10), pady=8)

        self.title = ctk.CTkLabel(self, text=short(title), anchor="e", justify="right", font=("Segoe UI", 13, "bold"))
        self.title.grid(row=0, column=1, sticky="ew", padx=4, pady=(8, 0))

        self.bar = ctk.CTkProgressBar(self, height=6)
        self.bar.set(0)
        self.bar.grid(row=1, column=1, sticky="ew", padx=6, pady=4)

        self.status = ctk.CTkLabel(self, text="⏳ بالانتظار", anchor="e", justify="right", text_color=("#555", "#aaa"))
        self.status.grid(row=2, column=1, sticky="ew", padx=4, pady=(0, 8))
        self.status.bind("<Button-1>", self._show_error)

        # الأزرار (يسار)
        self.btns = ctk.CTkFrame(self, fg_color="transparent")
        self.btns.grid(row=0, column=0, rowspan=3, padx=8)
        mk = lambda text, cmd: ctk.CTkButton(self.btns, text=text, width=34, height=30, command=cmd)
        self.btn_cancel = mk("✖", lambda: app.cancel_task(task.tid))
        self.btn_retry = mk("🔁", lambda: app.retry_task(task.tid))
        self.btn_open = mk("📂", lambda: app.show_file(task.tid))
        self.btn_remove = mk("🗑", lambda: app.remove_task(task.tid))
        self.set_state("queued")

    def set_title(self, text):
        self.title.configure(text=short(text))

    def set_status(self, text):
        self.status.configure(text=short(text, 110))

    def set_cover(self, pil_img):
        self._img = ctk.CTkImage(light_image=pil_img, dark_image=pil_img, size=(COVER_PREVIEW, COVER_PREVIEW))
        self.cover.configure(image=self._img, text="")

    def set_state(self, state):
        for b in (self.btn_cancel, self.btn_retry, self.btn_open, self.btn_remove):
            b.pack_forget()
        if state in Task.ACTIVE:
            self.btn_cancel.pack(pady=2)
        if state in ("error", "cancelled"):
            self.btn_retry.pack(pady=2)
        if state in ("done", "skipped"):
            self.btn_open.pack(pady=2)
        if state not in Task.ACTIVE:
            self.btn_remove.pack(pady=2)
        color = self.COLORS.get(state)
        if color:
            self.bar.configure(progress_color=color)
        else:
            self.bar.configure(progress_color=ctk.ThemeManager.theme["CTkProgressBar"]["progress_color"])
        if state == "done":
            self.bar.set(1)

    def _show_error(self, _e=None):
        if self.task.state == "error" and self.task.error_full:
            messagebox.showinfo("تفاصيل الخطأ", self.task.error_full)


# ====================== التطبيق ======================
class App(ctk.CTk):
    def __init__(self):
        self.cfg = load_config()
        ctk.set_appearance_mode(self.cfg["theme"])
        ctk.set_default_color_theme("blue")
        super().__init__()
        self.title("تنزيل الأغاني 🎵")
        self.geometry("920x760")
        self.minsize(780, 580)

        self.pool = ThreadPoolExecutor(max_workers=self.cfg["parallel"])
        self.events = queue.Queue()
        self.tasks = {}
        self._next_id = 0
        self._tick = 0
        self._last_clip = ""

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.bind("<Control-Return>", lambda e: self.add_from_text())
        self.text.focus_set()

        if not shutil.which("ffmpeg"):
            self.after(500, lambda: messagebox.showwarning(
                "تنبيه",
                "ffmpeg غير موجود، وهو ضروري لتحويل الصوت وتضمين الغلاف.\n"
                "ثبّته بالأمر: winget install ffmpeg\nثم أغلق البرنامج وافتحه من جديد.",
            ))
        self.after(150, self.poll)

    # ---------- بناء الواجهة ----------
    def _build_ui(self):
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", padx=14, pady=(12, 4))
        ctk.CTkLabel(top, text="الصق الروابط هنا (أغنية، أو قائمة تشغيل كاملة، رابط بكل سطر)", anchor="e").pack(fill="x")
        self.text = ctk.CTkTextbox(top, height=90, wrap="word")
        self.text.pack(fill="x", pady=6)
        b = ctk.CTkFrame(top, fg_color="transparent")
        b.pack(fill="x")
        ctk.CTkButton(b, text="⬇ تنزيل  (Ctrl+Enter)", command=self.add_from_text).pack(side="right")
        ctk.CTkButton(b, text="📋 لصق وتنزيل", command=self.paste_and_download).pack(side="right", padx=6)

        # --- الإعدادات ---
        st = ctk.CTkFrame(self)
        st.pack(fill="x", padx=14, pady=6)

        r1 = ctk.CTkFrame(st, fg_color="transparent")
        r1.pack(fill="x", padx=10, pady=(8, 2))
        ctk.CTkLabel(r1, text="الصيغة:").pack(side="right", padx=(0, 4))
        self.fmt_menu = ctk.CTkOptionMenu(r1, values=list(FORMATS), width=110, command=lambda v: self.on_setting())
        self.fmt_menu.set(self.cfg["format"])
        self.fmt_menu.pack(side="right", padx=(0, 16))
        ctk.CTkLabel(r1, text="الجودة (kbps):").pack(side="right", padx=(0, 4))
        self.q_menu = ctk.CTkOptionMenu(r1, values=QUALITIES, width=80, command=lambda v: self.on_setting())
        self.q_menu.set(self.cfg["quality"])
        self.q_menu.pack(side="right", padx=(0, 16))
        ctk.CTkLabel(r1, text="تنزيلات متزامنة:").pack(side="right", padx=(0, 4))
        self.par_menu = ctk.CTkOptionMenu(r1, values=[str(i) for i in range(1, 9)], width=70, command=lambda v: self.on_setting())
        self.par_menu.set(str(self.cfg["parallel"]))
        self.par_menu.pack(side="right")

        r2 = ctk.CTkFrame(st, fg_color="transparent")
        r2.pack(fill="x", padx=10, pady=2)
        self.v_embed = tk.BooleanVar(value=self.cfg["embed_thumb"])
        self.v_crop = tk.BooleanVar(value=self.cfg["crop_square"])
        self.v_arch = tk.BooleanVar(value=self.cfg["use_archive"])
        self.v_clip = tk.BooleanVar(value=self.cfg["watch_clipboard"])
        for text, var in (
            ("🖼 تضمين الغلاف داخل الملف", self.v_embed),
            ("◼ قص الغلاف مربع", self.v_crop),
            ("⏭ تخطي المنزّل سابقاً", self.v_arch),
            ("📋 مراقبة الحافظة", self.v_clip),
        ):
            ctk.CTkCheckBox(r2, text=text, variable=var, command=self.on_setting).pack(side="right", padx=(0, 16))

        r3 = ctk.CTkFrame(st, fg_color="transparent")
        r3.pack(fill="x", padx=10, pady=(2, 8))
        ctk.CTkButton(r3, text="📁 تغيير", width=80, command=self.choose_dir).pack(side="left")
        self.dir_label = ctk.CTkLabel(r3, text="", anchor="e", text_color=("#555", "#aaa"))
        self.dir_label.pack(side="right", fill="x", expand=True, padx=(10, 0))
        self._refresh_dir_label()

        # --- شريط الأدوات ---
        tb = ctk.CTkFrame(self, fg_color="transparent")
        tb.pack(fill="x", padx=14, pady=2)
        ctk.CTkButton(tb, text="📂 فتح المجلد", width=110, command=self.open_folder).pack(side="right")
        ctk.CTkButton(tb, text="🧹 مسح المنتهي", width=110, command=self.clear_done).pack(side="right", padx=6)
        ctk.CTkButton(tb, text="⛔ إيقاف الكل", width=110, fg_color="#b34040", hover_color="#8f3131",
                      command=self.cancel_all).pack(side="right")
        self.btn_update = ctk.CTkButton(tb, text="🔄 تحديث yt-dlp", width=120, command=self.update_ytdlp)
        self.btn_update.pack(side="left")
        ctk.CTkButton(tb, text="🌓", width=40, command=self.toggle_theme).pack(side="left", padx=6)

        self.listbox = ctk.CTkScrollableFrame(self)
        self.listbox.pack(fill="both", expand=True, padx=14, pady=6)

        self.footer = ctk.CTkLabel(self, text="", anchor="e", text_color=("#555", "#aaa"))
        self.footer.pack(fill="x", padx=16, pady=(0, 8))
        self._apply_format_state()

    def _refresh_dir_label(self):
        self.dir_label.configure(text=f"مكان الحفظ: {short(self.cfg['save_dir'], 90)}")

    def _apply_format_state(self):
        fmt = FORMATS[self.fmt_menu.get()]
        lossless_or_video = fmt["codec"] in ("flac", "mp4")
        self.q_menu.configure(state="disabled" if lossless_or_video else "normal")
        if self.fmt_menu.get() == "flac" and not HAS_MUTAGEN and self.v_embed.get():
            self.set_footer("⚠ تضمين الغلاف بصيغة flac يحتاج:  pip install mutagen")

    # ---------- إعدادات ----------
    def on_setting(self):
        self.cfg["format"] = self.fmt_menu.get()
        self.cfg["quality"] = self.q_menu.get()
        self.cfg["embed_thumb"] = self.v_embed.get()
        self.cfg["crop_square"] = self.v_crop.get()
        self.cfg["use_archive"] = self.v_arch.get()
        new_par = int(self.par_menu.get())
        if new_par != self.cfg["parallel"]:
            self.cfg["parallel"] = new_par
            old = self.pool
            self.pool = ThreadPoolExecutor(max_workers=new_par)
            old.shutdown(wait=False)   # القديمة بتكمّل اللي بالطابور ثم تنتهي
        was = self.cfg["watch_clipboard"]
        self.cfg["watch_clipboard"] = self.v_clip.get()
        if self.cfg["watch_clipboard"] and not was:
            try:
                self._last_clip = self.clipboard_get().strip()   # ما نحمّل شي قديم بالحافظة
            except tk.TclError:
                self._last_clip = ""
        self._apply_format_state()
        save_config(self.cfg)

    def choose_dir(self):
        d = filedialog.askdirectory(initialdir=self.cfg["save_dir"], title="اختر مجلد الحفظ")
        if d:
            self.cfg["save_dir"] = os.path.normpath(d)
            self._refresh_dir_label()
            save_config(self.cfg)

    def toggle_theme(self):
        self.cfg["theme"] = "light" if ctk.get_appearance_mode().lower() == "dark" else "dark"
        ctk.set_appearance_mode(self.cfg["theme"])
        save_config(self.cfg)

    def set_footer(self, text):
        self.footer.configure(text=text)

    # ---------- إضافة روابط ----------
    def paste_and_download(self):
        try:
            clip = self.clipboard_get()
        except tk.TclError:
            return
        self.text.insert("end", clip + "\n")
        self.add_from_text()

    def add_from_text(self):
        raw = self.text.get("1.0", "end")
        urls = re.findall(r"https?://[^\s,]+", raw)
        if not urls:
            messagebox.showinfo("لا يوجد روابط", "الصق رابط واحد على الأقل (يبدأ بـ http).")
            return
        self.text.delete("1.0", "end")
        active_urls = {t.url for t in self.tasks.values() if t.active}
        skipped = 0
        seen = set()
        for u in urls:
            if u in active_urls or u in seen:
                skipped += 1
                continue
            seen.add(u)
            self.start_url(u)
        if skipped:
            self.set_footer(f"تم تجاهل {skipped} رابط مكرر (موجود أصلاً بالقائمة)")

    def new_task(self, url, folder=None, title=None):
        self._next_id += 1
        t = Task(self._next_id, url, folder)
        t.row = Row(self.listbox, self, t, title or url)
        t.row.pack(fill="x", pady=4)
        self.tasks[t.tid] = t
        return t

    def start_url(self, url):
        t = self.new_task(url)
        if is_single_video(url):
            self.submit(t)
        else:
            t.state = "expanding"
            t.row.set_state("expanding")
            t.row.set_status("🔎 فحص الرابط...")
            threading.Thread(target=self.expand, args=(t.tid, url), daemon=True).start()

    def expand(self, tid, url):
        """يفحص الرابط: لو قائمة تشغيل بيرجع كل الأغاني، وإلا بيرجع None."""
        try:
            opts = {
                "quiet": True, "no_warnings": True, "skip_download": True,
                "extract_flat": "in_playlist", "noplaylist": False,
                "logger": QuietLogger(),
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info and info.get("_type") == "playlist" and info.get("entries"):
                entries = []
                for e in info["entries"]:
                    if not e:
                        continue
                    u = e.get("url") or e.get("webpage_url")
                    if u and not u.startswith("http") and e.get("id"):
                        u = f"https://www.youtube.com/watch?v={e['id']}"
                    if u:
                        entries.append((u, e.get("title") or u))
                self.events.put(("expanded", tid, entries, safe_name(info.get("title"))))
            else:
                self.events.put(("expanded", tid, None, None))
        except Exception as e:
            log.exception("expand failed")
            self.events.put(("fail", tid, clean_error(e)))

    def submit(self, t):
        t.cfg = dict(self.cfg)
        t.cancel = threading.Event()
        t.state = "queued"
        t.error_full = ""
        t.row.bar.set(0)
        t.row.set_state("queued")
        t.row.set_status("⏳ بالانتظار")
        t.future = self.pool.submit(self.worker, t)

    # ---------- العمل بالخيوط ----------
    def worker(self, t):
        put = self.events.put
        tid = t.tid
        if t.cancel.is_set():
            put(("state", tid, "cancelled", "⛔ أُلغيت"))
            return
        put(("state", tid, "running", "🔍 جاري التحضير..."))
        logger = QuietLogger()
        last = {"t": 0.0}

        def hook(d):
            if t.cancel.is_set():
                raise CancelExc()
            info = d.get("info_dict") or {}
            if not t.meta_sent and info.get("title"):
                t.meta_sent = True
                cands = []
                if info.get("thumbnail"):
                    cands.append(info["thumbnail"])
                for th in reversed(info.get("thumbnails") or []):
                    if th.get("url") and th["url"] not in cands:
                        cands.append(th["url"])
                put(("meta", tid, info["title"], cands[:4]))
            st = d.get("status")
            if st == "downloading":
                now = time.time()
                if now - last["t"] < 0.2:
                    return
                last["t"] = now
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                speed = d.get("speed")
                sp = f"  {speed / 1048576:.1f} MB/s" if speed else ""
                if total:
                    frac = min(1.0, d["downloaded_bytes"] / total)
                    put(("progress", tid, frac))
                    put(("status", tid, f"⬇ {frac * 100:.0f}%{sp}"))
                else:
                    put(("status", tid, "⬇ جاري التنزيل..."))
            elif st == "finished":
                put(("progress", tid, 1.0))
                put(("status", tid, "🔄 معالجة..."))

        PP_TEXT = {
            "ExtractAudio": "🔄 تحويل الصوت...",
            "Metadata": "🏷 كتابة معلومات الأغنية...",
            "EmbedThumbnail": "🖼 تضمين الغلاف...",
            "MoveFiles": "📦 نقل الملف...",
        }

        def pp_hook(d):
            if d.get("status") == "started":
                txt = PP_TEXT.get(d.get("postprocessor"))
                if txt:
                    put(("status", tid, txt))

        opts = build_opts(t.cfg, t.folder, logger)
        opts["progress_hooks"] = [hook]
        opts["postprocessor_hooks"] = [pp_hook]
        opts["post_hooks"] = [lambda path: put(("file", tid, path))]
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([t.url])
            if t.cancel.is_set():
                put(("state", tid, "cancelled", "⛔ أُلغيت"))
            elif logger.skipped:
                put(("state", tid, "skipped", "⏭ موجودة مسبقاً (تم التخطي)"))
            else:
                put(("state", tid, "done", "✅ تم"))
        except CancelExc:
            put(("state", tid, "cancelled", "⛔ أُلغيت"))
        except Exception as e:
            if t.cancel.is_set():
                put(("state", tid, "cancelled", "⛔ أُلغيت"))
                return
            log.exception("download failed: %s", t.url)
            full = clean_error(e)
            hint = ""
            if "ffmpeg" in full.lower() or "ffprobe" in full.lower():
                hint = " (ffmpeg غير مثبّت؟)"
            put(("fail", tid, full + hint))

    def fetch_thumb(self, tid, urls, square):
        for u in urls:
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = r.read()
                self.events.put(("thumb", tid, data, square))
                return
            except Exception:
                continue

    # ---------- تحديث الواجهة بأمان ----------
    def poll(self):
        try:
            for _ in range(500):
                self.handle(self.events.get_nowait())
        except queue.Empty:
            pass
        except Exception:
            log.exception("poll error")
        self._tick += 1
        if self._tick % 5 == 0:
            self.update_footer()
            if self.cfg["watch_clipboard"]:
                self.check_clipboard()
        self.after(120, self.poll)

    def handle(self, ev):
        kind, tid = ev[0], ev[1]
        t = self.tasks.get(tid)
        if t is None:
            return
        row = t.row
        if kind == "status":
            if t.state == "running":     # ما نكتب فوق حالة منتهية بتحديث متأخر
                row.set_status(ev[2])
        elif kind == "progress":
            if t.state == "running":
                row.bar.set(ev[2])
        elif kind == "meta":
            row.set_title(ev[2])
            t.title = ev[2]
            threading.Thread(
                target=self.fetch_thumb, args=(tid, ev[3], t.cfg["crop_square"]), daemon=True
            ).start()
        elif kind == "thumb":
            try:
                row.set_cover(make_cover(ev[2], COVER_PREVIEW, ev[3]))
            except Exception:
                log.exception("cover preview failed")
        elif kind == "file":
            t.path = ev[2]
        elif kind == "state":
            t.state = ev[2]
            row.set_state(ev[2])
            row.set_status(ev[3])
        elif kind == "fail":
            t.state = "error"
            t.error_full = ev[2]
            row.set_state("error")
            row.set_status("❌ " + short(ev[2], 90) + "   (اضغط لعرض التفاصيل)")
        elif kind == "expanded":
            entries, pname = ev[2], ev[3]
            if entries:
                self.remove_task(tid)
                for u, title in entries:
                    self.submit(self.new_task(u, folder=pname, title=title))
            else:
                self.submit(t)

    def update_footer(self):
        c = {"run": 0, "wait": 0, "done": 0, "err": 0}
        for t in self.tasks.values():
            if t.state == "running":
                c["run"] += 1
            elif t.state in ("queued", "expanding"):
                c["wait"] += 1
            elif t.state in ("done", "skipped"):
                c["done"] += 1
            elif t.state == "error":
                c["err"] += 1
        if any(c.values()):
            self.set_footer(f"جاري: {c['run']}   |   بالانتظار: {c['wait']}   |   منتهي: {c['done']}   |   فشل: {c['err']}")

    def check_clipboard(self):
        try:
            clip = self.clipboard_get().strip()
        except tk.TclError:
            return
        if clip == self._last_clip:
            return
        self._last_clip = clip
        if clip.startswith("http") and "\n" not in clip and any(h in clip for h in CLIP_HOSTS):
            if not any(t.url == clip and t.active for t in self.tasks.values()):
                self.start_url(clip)

    # ---------- أزرار الصفوف ----------
    def cancel_task(self, tid):
        t = self.tasks.get(tid)
        if not t or not t.active:
            return
        t.cancel.set()
        if t.future is not None and t.future.cancel():     # كانت بالطابور فقط
            t.state = "cancelled"
            t.row.set_state("cancelled")
            t.row.set_status("⛔ أُلغيت")
        elif t.state == "expanding":
            t.state = "cancelled"
            t.row.set_state("cancelled")
            t.row.set_status("⛔ أُلغيت")

    def retry_task(self, tid):
        t = self.tasks.get(tid)
        if t and t.state in ("error", "cancelled"):
            t.meta_sent = False
            self.submit(t)

    def show_file(self, tid):
        t = self.tasks.get(tid)
        if not t:
            return
        if t.path and os.path.exists(t.path) and os.name == "nt":
            subprocess.Popen(f'explorer /select,"{os.path.normpath(t.path)}"')
        else:
            folder = task_outdir(t.cfg or self.cfg, t.folder)
            os.makedirs(folder, exist_ok=True)
            open_path(folder)

    def remove_task(self, tid):
        t = self.tasks.pop(tid, None)
        if t:
            t.cancel.set()
            t.row.destroy()

    # ---------- أزرار عامة ----------
    def open_folder(self):
        os.makedirs(self.cfg["save_dir"], exist_ok=True)
        open_path(self.cfg["save_dir"])

    def clear_done(self):
        for tid, t in list(self.tasks.items()):
            if t.state in ("done", "skipped", "error", "cancelled"):
                self.remove_task(tid)

    def cancel_all(self):
        for tid in list(self.tasks):
            self.cancel_task(tid)

    def update_ytdlp(self):
        self.btn_update.configure(state="disabled", text="جاري التحديث...")

        def run():
            try:
                r = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
                    capture_output=True, text=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                ok = r.returncode == 0
                msg = "تم تحديث yt-dlp.\nأغلق البرنامج وافتحه من جديد لتفعيل التحديث." if ok else \
                    "فشل التحديث:\n" + (r.stderr or r.stdout)[-400:]
            except Exception as e:
                ok, msg = False, f"فشل التحديث: {e}"
            self.after(0, lambda: self._update_done(ok, msg))

        threading.Thread(target=run, daemon=True).start()

    def _update_done(self, ok, msg):
        self.btn_update.configure(state="normal", text="🔄 تحديث yt-dlp")
        (messagebox.showinfo if ok else messagebox.showerror)("تحديث yt-dlp", msg)

    # ---------- الإغلاق ----------
    def on_close(self):
        active = [t for t in self.tasks.values() if t.active]
        if active and not messagebox.askyesno(
            "تأكيد الإغلاق", f"في {len(active)} تنزيل شغّال. إذا أغلقت البرنامج رح يتوقفوا.\nتغلق؟"
        ):
            return
        for t in self.tasks.values():
            t.cancel.set()
        save_config(self.cfg)
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.destroy()

    def report_callback_exception(self, exc, val, tb):
        log.error("Tk callback exception", exc_info=(exc, val, tb))


if __name__ == "__main__":
    App().mainloop()
