# Alibot — Chatbot Flask

Website ini mengubah tiga praktikum pada Modul 9 menjadi satu aplikasi web:

- **Chat teks (Praktikum 9.1):** percakapan berulang dengan Gemini.
- **Chat suara (Praktikum 9.2):** rekam hingga 30 detik, hentikan otomatis setelah 2 detik hening, lalu transkripsikan dengan Gemini dan tampilkan jawaban teks.
- **Suara masuk & keluar (Praktikum 9.3):** rekam hingga 30 detik, hentikan otomatis setelah 2 detik hening, lalu transkripsikan dan bacakan jawaban dalam Bahasa Indonesia melalui fitur text-to-speech browser.

## Menjalankan aplikasi

1. Buat dan aktifkan virtual environment Python.
2. Pasang dependensi:

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Salin `.env.example` menjadi `.env`, lalu isi `GEMINI_API_KEY` dengan API key milik Anda. API key hanya digunakan oleh server Flask dan tidak dikirim ke browser.
4. Jalankan server:

   ```powershell
   python app.py
   ```

5. Buka `http://127.0.0.1:5000` di browser.

Perekaman suara memerlukan izin mikrofon dan konteks aman browser. `localhost` didukung untuk pengembangan; deployment harus menggunakan HTTPS.

Nama model mengikuti modul dan dapat diubah melalui `GEMINI_TEXT_MODEL`, `GEMINI_VOICE_MODEL`, dan `GEMINI_VOICE_OUT_MODEL` di `.env` apabila model tersebut tidak tersedia untuk akun Anda. Agar jawaban tetap lengkap tanpa boros kuota, panjangnya disesuaikan dengan pertanyaan dan dibatasi maksimal 1.024 token; transkripsi dibatasi maksimal 128 token, pesan maksimal 2.000 karakter, dan riwayat konteks maksimal tiga pertukaran terakhir. Jika Gemini sementara mengalami overload atau gangguan server, aplikasi mencoba ulang hingga tiga kali dengan jeda singkat. Konteks percakapan disimpan sementara di memori proses server dan dapat dihapus menggunakan tombol **Bersihkan percakapan**.
