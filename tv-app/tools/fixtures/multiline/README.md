Bu küçük test kareleri Part 06 videosunda aynı anda beş altyazı satırı görünen
iki sahneden üretildi: 06:07.500 (Security/Jason) ve 02:04:29.000 (La Polilla Negra).
540p, 720p ve 1080p görüntülerin alt %38'inin özgün Y düzlemi PNG olarak saklanır.
JPEG, kontrast iyileştirme veya OCR metnini resme yeniden çizme uygulanmaz.

scenes.json: kaynak replik kimliği, video zamanı, çözünürlük ve görüntü SHA-256.
readings.json: 1.0.28'deki altı satırlı paddle_ocr.c/ocr_image.c okuyucusunun Windows DLL
derlemesi ve ARM paketindekiyle aynı modellerle alınmış gerçek OCR çıktıları.

1.0.28 denemesinde altı karede de altyazı ön elemesi geçti ve beş satırın tamamı okundu.
1080p Security karesindeki bir harf hatası mevcut yaklaşık aramayla çözülür;
varsayılan %95 eşikte tüm altı okuma eksiksiz kaynak çevirisine eşleşir.
test_multiline.cjs bu metinleri gerçek sözlük, servis beslemesi ve isim/renk
göstericisi üzerinden doğrular. 1.0.29'da hız için üç satıra ve eski dar alana
dönüldü; bu kayıtlar geçmiş test referansıdır, güncel OCR kapsamı iddiası değildir.
Güncel OCR'yi yeniden çalıştırmak için:

python tv-app/tools/benchmark_multiline_ocr.py --library PATH_TO_NATIVE_DLL \
  --runtime PATH_TO_WINDOWS_PADDLE_RUNTIME --output output/ocr/multiline/benchmark.json

DLL, paddle_open/paddle_read/paddle_close/subtitle_band/subtitle_candidate
işlevlerini dışa aktarmalıdır. --baseline-library ile önceki okuyucu aynı
karelerde eski varsayılan tarama alanıyla karşılaştırılabilir.
Eski geniş alanlı okuyucuyu yeniden denemek için o dönemin DLL'i ile
--region-top 62 kullanılmalıdır; güncel varsayılan 77'dir.
