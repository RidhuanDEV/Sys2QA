# Alur kerja: Mengirim pendaftaran

Revisi `4b775e0c2a9d` · profil `standard` · status `partially_reconstructed`

1. Buka `page:web:/registrasi`.
2. Kirim `form:web:/registrasi#registration` (validasi: `business_rule:registration.nib_required_13_digits`).
3. `api:POST:/api/registrations` menulis `entity:registration` dan memanggil `integration:email.confirmation`.

Belum terselesaikan: pengiriman email terjadi di luar repositori (`gap:email-delivery`).
