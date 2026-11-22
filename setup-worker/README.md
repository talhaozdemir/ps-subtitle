# Telefon kurulumu ve eksik replik arşivi

Telefon formu yalnız doldurulan alanları şifreleyip TV'ye gönderir. Boş API anahtarı,
mod, sağlayıcı, görünüm veya görüntü alanları kayıtlı değerleri değiştirmez. Sadece
PS5 adresi gönderilebilir; bu işlem Remote Play eşleştirme anahtarlarını korur.
Yeniden eşleştirmede hesap kimliği ve PIN birlikte gereklidir; IP boşsa kayıtlı IP kullanılır.
TV, Uygula sırasında taslağı en son kayıtlı ayarlara birleştirir.

## Yayımlama

```powershell
cd setup-worker
npm ci
npx wrangler login
npm run archive:deploy -- --device lgtv
```

`archive:deploy`, Cloudflare hesabındaki Worker'a iki ayrı rastgele erişim anahtarı
kurar, SQLite Durable Object migrasyonunu ve telefon formunu yayımlar. Sonra yalnız
yazma anahtarını seçili TV'ye aktarır. Gemini/OpenAI anahtarı istemez veya taşımaz.
Mevcut anahtarlar otomatik döndürülmez. Yerel anahtar dosyası kayıpsa, Cloudflare'deki
mevcut anahtarların üstüne yazmak yerine durur.

Erişim anahtarları kullanıcı profilindeki `.config/ps-subtitle/archive-secrets.json`
dosyasında saklanır; kaynak koduna veya IPK'ye eklenmez. TV'deki yazma anahtarı
`/media/internal/.com.gtavi.turkce.altyazi/translation-archive.json` içindedir.
Kurulumun telefon formu için kullanılan geçici şifreli oturumlarla ortak anahtarı yoktur.
TV'nin 1.0.34 veya sonraki sürümü çalıştırması gerekir.

## Kayıt ve inceleme

Paket öncelikli modda yerel eşleştirme bulunamazsa, seçili sağlayıcının anahtarı varsa
replik doğrudan o sağlayıcıda çevrilir. Gemini için `gemini-3.5-flash-lite` ve
`/v1beta/interactions`, `Api-Revision: 2026-05-20` kullanılır. Başarılı eksik replik
çevirisi önce TV'deki `translation-outbox.json` dosyasına atomik olarak yazılır,
sonra HTTPS üzerinden Worker'a gönderilir. API hataları veya kısmi yanıtlar kaydedilmez.
Sadece API modu dil paketinin eksiklerini ölçmediği için arşive aday eklemez.

Arşiv, İngilizce metni, Türkçe öneriyi, sağlayıcı/modeli, OCR güvenini ve tarihleri
tutar. Gemini/OpenAI anahtarları gönderilmez. Kayıtlar `unreviewed` olarak saklanır;
incelenmiş dil paketi ve uygulamanın eşleştirme sonuçları kendiliğinden değişmez.
Aynı metin ve çevirinin yeniden gönderimi aynı SHA-256 kimliğiyle tekilleştirilir.
Farklı Türkçe karşılıklar ayrı adaylardır.

Bağlantı, erişim anahtarı veya disk sorunu halinde onaylanmamış kayıt silinmez.
TV kuyruğu 1.000, bulut arşivi 20.000 adayla sınırlıdır; dolu arşiv/kuyruk eski
kayıtları sessizce atmaz. `translationArchiveStatus` servis metodu anahtar içermeyen
`configured/pending/confirmed/busy/lastError` bilgisi döndürür. `confirmed` o servis
çalışması sırasında onaylanan kayıt sayısıdır. Bekleyen kayıtlar yeniden başlangıçta
veya yeni başarılı çeviride tekrar gönderilir.

Birleştirme için repo kökünden:

```powershell
node tv-app/tools/export_api_translations.cjs --output output/api-candidates-2026-11-22.json
```

Komut yerel okuma anahtarını kullanır; alternatif olarak `TRANSLATION_READ_TOKEN`
ortam değişkenini okuyabilir. Sayfalı, sabit üst sınırlı bir anlık görüntü üretir;
var olan çıktı dosyasının üstüne yazmaz. JSON aday listesi insan incelemesi içindir,
`subtitle.json.gz` dosyasına otomatik birleştirme yapmaz.

## Test

```powershell
npm test
```

Testler gerçek yerel workerd ve SQLite Durable Object üzerinde erişim ayrımı,
tekilleştirme, çakışmalar, geçersiz/çok büyük gövdeler, dışa aktarma, üretim TV gönderim
istemcisi ve şifreli telefon → Worker → TV aktarımını doğrular. Gerçek Gemini çağrısı
yapılmaz; canlı sağlayıcı doğrulaması için TV'deki Bağlantıyı test et düğmesi gerekir.

1.0.35 ile servis tanılamasında `testTranslation` metoduna `{ "archive": true }`
verildiğinde kayıt yolu da sınanır. Bu seçenek, `[PS Subtitle connectivity test]`
ile başlayan bir İngilizce test cümlesini gerçek sağlayıcıda çevirir, üretim TV
kuyruğuna yazar ve bulut onay durumuyla kayıt kimliğini döndürür. Bu etiketli aday
oyundan okunmuş bir replik değildir; dil paketi incelemesinde ayrı tutulmalıdır.
Normal Bağlantıyı test et düğmesi arşive test kaydı eklemez.
1.0.37 ile tanılamada isteğe bağlı `text` alanına en fazla 1.440 karakterlik bir
örnek verilebilir; boş/geçersiz metin reddedilir, kayıt istenirse test etiketi eklenir.
Dışa aktarma aracı bu etiketli kayıtları `testRecords` listesine ayırır; normal
konuşmaların `records` listesine katmaz.

1.0.38 ile `{ "display": true, "text": "..." }`, çalışan altyazı akışında ekran
testi yapar: etiketli kaynak okunur ve API yanıtından önce boş kare gönderilir.
Yanıt mevcut altyazı aboneliğine iletilir; kaynak artık yoksa okuma süresi sonunda
kaybolur. Bu, yalnız sağlayıcı yanıtı alan normal testten farklı olarak üretimdeki
çeviri/gösterim/kayıt yolunu kullanır. Altyazı akışı açık olmalıdır.
