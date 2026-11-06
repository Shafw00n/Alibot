import logging
import os
import re
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from werkzeug.datastructures import FileStorage


load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY") or os.urandom(32)
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024

TEXT_MODEL = os.getenv("GEMINI_TEXT_MODEL", "gemini-3.6-flash")
VOICE_MODEL = os.getenv("GEMINI_VOICE_MODEL", "gemini-3.5-flash")
VOICE_OUT_MODEL = os.getenv("GEMINI_VOICE_OUT_MODEL", "gemini-3.7-flash")
MAX_OUTPUT_TOKENS = 1024
MAX_TRANSCRIPT_TOKENS = 128
MAX_INPUT_CHARS = 2000
MAX_HISTORY_MESSAGES = 6
MAX_CONVERSATIONS = 256
MAX_GEMINI_ATTEMPTS = 3
RETRYABLE_GEMINI_STATUS_CODES = {429, 500, 502, 503, 504}
conversations: dict[str, list[dict[str, object]]] = {}
REPLY_CONFIG = types.GenerateContentConfig(
    system_instruction=(
        "Sesuaikan panjang jawaban dengan pertanyaan. Untuk pertanyaan sederhana, jawab singkat. "
        "Untuk permintaan penjelasan, alasan, daftar, contoh, atau langkah, berikan jawaban yang "
        "cukup lengkap dan jelas, jangan berhenti setelah satu kalimat jika masih ada bagian penting. "
        "Tetap fokus dan hindari pengulangan atau uraian yang tidak diperlukan. "
        "Gunakan Bahasa Indonesia kecuali diminta bahasa lain. "
        "Tulis sebagai teks biasa tanpa Markdown; jangan gunakan format tebal atau penanda format."
    ),
    max_output_tokens=MAX_OUTPUT_TOKENS,
)
TRANSCRIPTION_CONFIG = types.GenerateContentConfig(
    max_output_tokens=MAX_TRANSCRIPT_TOKENS,
)


class GeminiBusyError(Exception):
    pass


def get_client() -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise ValueError(
            "API key belum diatur. Isi GEMINI_API_KEY di file .env lalu mulai ulang server."
        )
    return genai.Client(api_key=api_key)


def generate_content_with_retry(client: genai.Client, **kwargs):
    for attempt in range(MAX_GEMINI_ATTEMPTS):
        try:
            return client.models.generate_content(**kwargs)
        except genai_errors.APIError as exc:
            if exc.code not in RETRYABLE_GEMINI_STATUS_CODES:
                raise
            if attempt == MAX_GEMINI_ATTEMPTS - 1:
                raise GeminiBusyError from exc
            delay = 2**attempt
            app.logger.warning(
                "Gemini sementara tidak tersedia (HTTP %s); mencoba lagi dalam %s detik.",
                exc.code,
                delay,
            )
            time.sleep(delay)
    raise RuntimeError("Percobaan Gemini selesai tanpa respons.")


def current_conversation() -> list[dict[str, object]]:
    conversation_id = session.get("conversation_id")
    if not conversation_id:
        conversation_id = os.urandom(24).hex()
        session["conversation_id"] = conversation_id
    if conversation_id not in conversations and len(conversations) >= MAX_CONVERSATIONS:
        oldest_conversation = next(iter(conversations), None)
        if oldest_conversation is not None:
            conversations.pop(oldest_conversation)
    return conversations.setdefault(conversation_id, [])


def save_exchange(history: list[dict[str, object]], prompt: str, reply: str) -> None:
    history.extend(
        [
            {"role": "user", "parts": [{"text": prompt}]},
            {"role": "model", "parts": [{"text": reply}]},
        ]
    )
    del history[:-MAX_HISTORY_MESSAGES]


def generate_reply(prompt: str, model: str) -> str:
    history = current_conversation()
    client = get_client()
    contents = [
        *history,
        {"role": "user", "parts": [{"text": prompt}]},
    ]
    response = generate_content_with_retry(
        client,
        model=model,
        contents=contents,
        config=REPLY_CONFIG,
    )
    reply = (response.text or "").strip()
    if not reply:
        raise RuntimeError("Gemini tidak memberikan respons teks.")
    reply = re.sub(r"\*\*|__", "", reply)
    save_exchange(history, prompt, reply)
    return reply


def transcribe_audio(audio_file: FileStorage, model: str) -> str:
    client = get_client()
    uploaded_audio = None
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            suffix = Path(audio_file.filename or "").suffix.lower()
            if suffix not in {".webm", ".wav", ".mp3", ".m4a", ".ogg"}:
                suffix = ".webm"
            audio_path = Path(temp_dir) / f"recording{suffix}"
            audio_file.save(audio_path)
            uploaded_audio = client.files.upload(file=str(audio_path))
            response = generate_content_with_retry(
                client,
                model=model,
                contents=[
                    uploaded_audio,
                    (
                        "Transkripkan audio ini ke teks persis seperti yang diucapkan. "
                        "HANYA TULISKAN TEKS TRANSKRIPSI MENTAHNYA tanpa tambahan kata lain. "
                        "Jika audio hening atau hanya noise, tulis 'HENING'."
                    ),
                ],
                config=TRANSCRIPTION_CONFIG,
            )
        return (response.text or "").strip() or "HENING"
    finally:
        if uploaded_audio is not None:
            try:
                client.files.delete(name=uploaded_audio.name)
            except Exception:
                app.logger.warning("Gagal menghapus berkas audio sementara di Gemini.", exc_info=True)


@app.get("/")
def index():
    return render_template(
        "index.html",
        models={
            "text": TEXT_MODEL,
            "voice": VOICE_MODEL,
            "voice_out": VOICE_OUT_MODEL,
        },
    )


@app.get("/api/config")
def config():
    return jsonify({"api_key_configured": bool(os.getenv("GEMINI_API_KEY", "").strip())})


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Format pesan tidak valid."}), 400
    message = data.get("message", "")
    if not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Pesan tidak boleh kosong."}), 400
    if len(message) > MAX_INPUT_CHARS:
        return jsonify({"error": "Pesan terlalu panjang (maksimal 2.000 karakter)."}), 400

    try:
        reply = generate_reply(message.strip(), TEXT_MODEL)
        return jsonify({"reply": reply})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 503
    except GeminiBusyError:
        return jsonify(
            {"error": "Gemini sedang sibuk. Coba kirim pesan lagi dalam beberapa saat."}
        ), 503
    except Exception as exc:
        app.logger.exception("Permintaan chatbot teks gagal.")
        return jsonify({"error": f"Gagal mendapatkan respons Gemini: {exc}"}), 502


@app.post("/api/voice")
def voice():
    audio_file = request.files.get("audio")
    mode = request.form.get("mode", "voice")
    if mode not in {"voice", "voice_out"}:
        return jsonify({"error": "Mode suara tidak dikenal."}), 400
    if audio_file is None or not audio_file.filename:
        return jsonify({"error": "Rekaman audio tidak ditemukan."}), 400

    try:
        model = VOICE_OUT_MODEL if mode == "voice_out" else VOICE_MODEL
        transcript = transcribe_audio(audio_file, model)
        if transcript.casefold() == "hening":
            return jsonify(
                {
                    "transcript": "HENING",
                    "reply": None,
                }
            )
        if len(transcript) > MAX_INPUT_CHARS:
            return jsonify(
                {"error": "Transkripsi terlalu panjang (maksimal 2.000 karakter)."}
            ), 400

        reply = generate_reply(transcript, model)
        return jsonify({"transcript": transcript, "reply": reply})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 503
    except GeminiBusyError:
        return jsonify(
            {"error": "Gemini sedang sibuk. Coba kirim rekaman lagi dalam beberapa saat."}
        ), 503
    except Exception as exc:
        app.logger.exception("Permintaan chatbot suara gagal.")
        return jsonify({"error": f"Gagal memproses suara: {exc}"}), 502


@app.post("/api/clear")
def clear_conversation():
    conversation_id = session.pop("conversation_id", None)
    if conversation_id:
        conversations.pop(conversation_id, None)
    return jsonify({"ok": True})


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Berkas audio terlalu besar (maksimal 15 MB)."}), 413


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")
