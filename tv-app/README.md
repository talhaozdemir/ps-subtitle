# GTA VI Türkçe Altyazı

OLED55CX6LA ve webOS 5 hedeflenerek hazırlanmış TV uygulaması. Uygulama PS5’in HDMI görüntüsünü gösterir. İngilizce altyazıyı Uzaktan Oynatma veya deneysel HDMI kaynağından okur. Türkçe karşılık için yerel paket ve isteğe bağlı Gemini veya OpenAI bağlantısı kullanılabilir.

## Kurulum

1. LG Content Store’dan **Developer Mode** uygulamasını aç, LG geliştirici hesabıyla modu etkinleştir ve **Key Server**’ı aç.
2. Bilgisayarda [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) ile TV’yi ekle. TV’nin gösterdiği kodu kullanıp derlenen sürümün `com.gtavi.turkce_<sürüm>_all.ipk` dosyasını kur.
3. PS5’te ikinci bir PSN hesabıyla oturum aç. **Ayarlar → Sistem → Uzaktan Oynatma** bölümünde Uzaktan Oynatma’yı aç ve **Cihazı Bağla** ekranından 8 haneli kodu al.
4. TV ile PS5’i aynı ev ağına bağla. LG uygulaması ilk açılışta **HDMI** sekmesini gösterir. TV tek bir girişi PS5 olarak tanıyorsa o port otomatik seçilir. Gerekirse portu elle seç ve **PS5** sekmesinde **PS5’i bul** düğmesine bas. Konsol listelenmezse IPv4 adresini elle gir. İkinci hesabın sayısal veya Base64 PSN hesap kimliğini ve ekrandaki kodu gir, ardından **PS5’i eşleştir** düğmesine bas. [PSN hesap kimliği arama sayfası](https://psn.flipscreen.games/)
5. **Altyazı** adımında PS5’te ana hesabına dön, İngilizce oyun altyazısını aç ve **Altyazıyı dene** düğmesine bas. Bağlantı kurulunca **Kurulumu bitir** ile tamamla. Sonraki açılışlarda uygulama kayıtlı ayarlarla altyazıyı başlatır.

PS5 eşleştirildikten sonra okuma çözünürlüğünü seçmen yeterli; seçim otomatik kaydedilip uygulanır. **Altyazıyı başlat** düğmesine ayrıca basman gerekmez ve ayar ekranı açık kalır. Çözünürlük değişimi Remote Play bağlantısını yeniden kurar; uygulama eski oturumun kapanmasını bekler. PS5 geçici olarak meşgulse 2, 5 ve 10 saniye arayla yeniden dener.

Oyun sırasında ayarlara LG kumandasındaki **Geri** tuşuyla dönülür. Varsayılan okuma çözünürlüğü 540p. TV’nin yükünü azaltmak için 360p, küçük yazıları okumak için 720p veya 1080p denenebilir. Bu ayar altyazı okuma akışına ait. Uygulama altyazı başlarken eşleştirilmiş PS5’i ağda arar ve IP adresi değişmişse yeni adresi kaydeder. PS5’i bulamazsa son kayıtlı adresi dener. Bu özellik eklenmeden önce eşleştirilen konsolları bir kez yeniden eşleştirerek otomatik adres güncellemesini etkinleştir.

### Deneysel HDMI kaynağı

**Altyazı** sekmesinde **Altyazı kaynağı → HDMI (deneysel)** seç ve altyazıyı başlat. TV’nin ilk bağlantı onayını kabul et. Uygulama HDMI görüntüsünün 540p JPEG karesini yerel, kalıcı HTTPS bağlantısıyla alır ve seçili metin bölgesini çözer. PS5’te İngilizce altyazıyı açık tut. TV eşleştirmesi yalnızca `CONTROL_DISPLAY` izni ister.

### iPhone veya bilgisayardan ayar girme

1. TV’de **Başka cihazdan doldur** düğmesine bas. iPhone’da QR kodunu okut. Bilgisayarda TV’de gösterilen adresi aç ve 5 dakikalık kurulum kodunu gir.
2. Tarayıcıda değiştirmek istediğin alanları seç. PS5 eşleştirme bilgileri, HDMI girişi, okuma çözünürlüğü, altyazı alanı ve görünümü ile çeviri ayarlarını birlikte veya ayrı ayrı gönderebilirsin. Gemini ve OpenAI anahtarları aynı gönderimde girilebilir. Boş bıraktığın isteğe bağlı alanlar kayıtlı değerlerini kullanır.
3. **TV’ye gönder** düğmesine bas. TV’de gelen ayarları kontrol edip **Uygula**’yı seç.

TV ile formu açan cihaz internete bağlı olduğu sürece farklı ağları kullanabilir. Tarayıcı veriyi şifreler ve Worker yalnızca şifreli paketi geçici olarak tutar. TV uyguladıktan sonra oturumu kapatır. PS5 eşleştirmesi için TV ile konsol aynı yerel ağda kalır.

Kurulum formunu ve eksik replik arşivini yayımlama adımları `setup-worker/README.md` içindedir. Worker yapılandırması geçici şifreli oturumlar ve kalıcı inceleme arşivi için ayrı SQLite Durable Object bağları içerir. [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/)

### Altyazı alanı

**Geri → Altyazı → Okuma sıklığı** ayarı kumandada sol ve sağ tuşlarla 1–10 arasında seçilir. Değer, saniyede en fazla kaç aday karenin OCR için seçileceğini belirler. Varsayılan 3, yaklaşık 333 ms; 2 yaklaşık 500 ms, 10 yaklaşık 100 ms aralıktır. **Sıklığı kaydet** seçimi TV’de saklar ve çalışan akışa yeniden bağlantı kurmadan uygular. Yüksek değer daha sık kontrol ve daha fazla işlem yükü demektir. Aynı görüntüyü atlama ve altyazı adayı yokken seyrek kontrol sürer; Remote Play’in video kare hızı değişmez.

GTA VI’da İngilizce altyazının arka planı **Düz / Solid** olarak ayarlandığında uygulama koyu lacivert kutuyu rengi, kenarları ve konumuyla doğrular ve içindeki yazıyı okur. Kutu doğrulanamazsa veya yazı düşük güvenle okunursa uygulama ayarladığın alanın içindeki hizalı altyazı satırlarını da arar.

İngilizce bir altyazı ekrandayken **Geri → Altyazı alanı** menüsünü aç. Kutuyu yön tuşlarıyla taşı, **OK** ile boyutlandırmaya geç. Sol ve sağ tuşlar genişliği, yukarı ve aşağı tuşlar yüksekliği değiştirir. Magic Remote işaretçisiyle kutuyu veya boyutlandırma köşesini sürükleyebilirsin. Boyutlandırma kutunun merkezini korur ve ekran kenarlarında durur.

Remote Play bağlıyken kutudan okunan İngilizce metin üstte görünür. Görünebilecek bütün altyazı satırlarının etrafında pay bırak. **OK** alanı kaydedip oyuna döner, **Geri** önceki ayara döner. Kayıt sonraki açılışta da kullanılır.

Varsayılan konuşma kutusu ekranın solundan %6, üstünden %67 başlar ve %88 × %26 boyutundadır. Küçük ve normal altyazılar aynı kutudan okunur. **Görev yazısı alanı → Boyut 2**, sol %24 ve üst %93 konumunda %52 × %7 boyutundaki kutuyu seçer. Sağ alttaki tuş ipuçları sol %80 ve üst %92 konumundaki sabit %20 × %8 kutudan okunur ve ekranda kendi çevirisiyle gösterilir.

### Altyazı görünümü

Kumandada **Geri → Altyazı görünümü** menüsünü aç. Türkçe altyazıyı alt veya üst ortaya alabilir, seçili kenardan uzaklığını ekran yüksekliğinin %0–30’u arasında ayarlayabilirsin. Yazı boyutu 24–64 px arasında değişir. Siyah arka plan açıkken opaklığı, yatay boşluğu (0–100 px) ve dikey boşluğu (0–60 px) ayrı ayrı ayarlayabilirsin.

Kumandanın yukarı ve aşağı tuşlarıyla ayar seç, sol ve sağ tuşlarıyla kaydırıcıları değiştir. **Konuşmacı isimleri** düğmesi isim gösterimini açar veya kapatır; varsayılan kapalıdır. Açıkken güvenle belirlenen konuşmacı adı kendi kayıtlı renginde, replik beyaz görünür. İsim olmayan veya konuşmacısı belirsiz kayıtta yalnız replik gösterilir. Renk ölçülememişse bilinen renk ailesi kullanılır; renk de belirsizse isim normal yazı renginde kalır. Örnek altyazı değişiklikleri anında gösterir. **Kaydet** seçimleri TV’de saklar; **İptal** kayıtlı ayara döner.

### GitHub’dan altyazı güncelleme

1. [Altyazı reposuna](https://github.com/talhaozdemir/ps-subtitle) ilk commit’i ekle. Boş repoda bir README yeterli.
2. [Yeni yayın oluştur](https://github.com/talhaozdemir/ps-subtitle/releases/new). Örneğin `pack-v5` etiketi seç, `dist/subtitle.json.gz` dosyasını yayın eki olarak yükle ve normal yayın olarak yayımla.
3. TV’de **Geri → Altyazı paketini güncelle** seçeneğine bas. Dosya doğrulanıp TV’ye kaydedilince yeni çeviriler mevcut oturumda devreye girer.

Sonraki yayınlarda aynı `subtitle.json.gz` dosya adını kullan. Tekilleştirilmiş paket `gta-6` kimlikli biçim 3 kullanır ve güncel uygulama koduyla birlikte kullanılmalıdır. Güncel uygulama eski biçim-2 paketlerini de okur; eski uygulamalar biçim 3 paketini reddederek çalışan eski sözlüğünü korur. TV, GitHub’ın dosya boyutu ve SHA-256 bilgisini kontrol eder. Sorun olursa son çalışan kopya devrede kalır. Paket indirmek için internet bağlantısı gerekir.

### Canlı çeviri

**Geri → Altyazı → Çeviri → En düşük benzerlik** ayarı, **Paket öncelikli** modda %80–100 arasında seçilebilir. Kumandada sol ve sağ tuşlarla değiştirip **Kaydet** ile uygula. Varsayılan %95. Birebir eşleşmeler önce aranır. Sonuç bulunmazsa uygulama bilinen okuma hatalarını dener ve geniş paketteki benzerlik dizinine bakar. %100 yaklaşık eşleşmeleri kapatır. Benzerliği birbirine çok yakın iki farklı çeviri elenir.

1. Kullanacağın hizmetten bir API anahtarı oluştur. [Gemini API anahtarı](https://aistudio.google.com/apikey) · [OpenAI API anahtarı](https://platform.openai.com/api-keys)
2. TV’de **Geri → Altyazı → Çeviri** ekranında **API sağlayıcısı** olarak Gemini veya OpenAI’yi seç ve anahtarını gir. **Bağlantıyı test et** düğmesi seçili sağlayıcıyla örnek bir replik çevirir.
3. Çeviri kaynağını seç ve **Kaydet** düğmesine bas.

**Paket öncelikli** mod, eski geniş paket ile 1–9. bölümden kontrol edilmiş çevirileri birleştiren tek GTA VI sözlüğünü kullanır. Ortak repliklerde karşılaştırılarak seçilen Türkçe karşılık aranır. Karşılık bulunmazsa replik seçili API sağlayıcısına gönderilir. Seçili sağlayıcının anahtarı yoksa bu mod yerel sözlükle çalışır. Bağlama göre farklı anlam taşıyan ve güvenle ayırt edilemeyen kısa replikler yanlış çeviri göstermemek için eşleştirilmez. **Sadece API** modunda her yeni replik seçili sağlayıcıyla çevrilir. Tekrarlanan API çevirileri oturum boyunca TV’nin belleğinde tutulur.

TV, OCR ile okuduğu altyazı metnini HTTPS üzerinden doğrudan seçili sağlayıcıya gönderir. Gemini, **Gemini 3.5 Flash-Lite** kullanır. OpenAI, **GPT‑6 Luna** modelini `reasoning.effort: none` ayarıyla kullanır. Anahtarlar TV’de ayrı ayrı saklanır. **Anahtarı kaldır → Kaydet** seçili sağlayıcının anahtarını siler ve yerel paket moduna döner.

**1.0.34:** Paket öncelikli modda bulunamayan ve API'de başarıyla çevrilen replikler,
Cloudflare kurulumu yapıldığında sonradan incelemek/birleştirmek için kalıcı arşive
gönderilir. Önce TV'ye yazılan kuyruk, bulut onayından sonra temizlenir; bağlantı
kesildiğinde yeniden dener. İngilizce/Türkçe metin ve kaynak bilgileri kaydedilir,
Gemini/OpenAI anahtarları kaydedilmez. Çakışan çeviriler ayrı inceleme adaylarıdır;
yerel dil paketine otomatik eklenmez. Arşiv erişim anahtarları IPK içinde bulunmaz.
Kurulum ve dışa aktarma için `setup-worker/README.md` dosyasına bak.

API, güncel OCR'nin 1.440 karaktere kadar çok satırlı bloklarını kabul eder. Düşük
güvenli okumalar filtrelenir. En fazla iki istek sürdürülür; yeni OCR eski isteği her
karede iptal etmez. Geç biten eski konuşma kaydedilebilir, ancak güncel altyazıyı
değiştiremez. Sağlayıcı/anahtar değişimi veya oturum sıfırlaması eski işleri iptal
eder; bağlam değişen aynı replik eski bağlamın işini kullanmaz. Tamamlanmamış API
yanıtları gösterilmez ve 429 yanıtının `Retry-After` süresi dikkate alınır.

`test_api_translation.cjs`, API istek/yanıt sözleşmesini, çok satırlı OCR'yi, geç
tamamlanan cevapları, iptalleri, hata/kota/zaman aşımını ve arşiv seçimlerini;
`test_translation_archive.cjs`, disk/kesinti/yeniden başlatma/kuyruk sınırlarını;
`test_remote_setup.cjs`, yalnız doldurulan alanların en son kayıtlı ayarlara
uygulanmasını sınar. Worker testleri gerçek yerel workerd/SQLite kullanır. Bunlar
gerçek anahtarla canlı Gemini çeviri doğrulaması değildir.

## Prototip doğrulaması

**1.0.40:** HTTP 500/502/503/504 yanıtlarında, toplam 5/8 saniyelik istek süresi
uzatılmadan en fazla bir yeniden deneme yapılır. İlk hata kuyruğu silmez ve hemen
uyarı çıkarmaz; 600–1.000 ms rastgele bekleme kullanılır. `Retry-After` varsa erken
denenmez; belirtilen süre kalan bütçeye sığmıyorsa kısa tekrar yapılmaz. Anahtar,
izin, geçersiz istek ve kota hataları bu yolla yeniden denenmez. Sıfırlama, anahtar
değişimi veya iptal bekleyen tekrarın da zamanlayıcısını temizler. Hata sürerse
mevcut geri çekilme ve uyarı geçerlidir; sunucu kesintisini uygulama gideremez.

Gerçek başarılı API yanıtından sonra eski Gemini uyarısı temizlenir; daha yeni
bir PS5 bağlantı uyarısı silinmez. `videoDiagnostics.video.api`, mantıksal istek
sayılarına ek olarak `httpAttempts`, `retried`, `transientResponses`, `retrying`,
`lastStatusCode` ve `lastErrorStatusCode` bilgilerini içerir. Anahtar veya ham
sağlayıcı hata gövdesi bu alanlara eklenmez.

**1.0.39:** Konuşmalar tek bir alttan büyüyen metin kutusu yerine, ayrı ve sabit
konumlu bloklar olarak çizilir. Yeni konuşmanın eklenmesi veya eski konuşmanın
süresinin dolması, ekranda kalan metinleri kaydırmaz; farklı uzunluklar eski
metnin satırlarını yeniden sardırmaz. Blokların arası boş satır yerine 4 pikseldir.
İlk blok kayıtlı konuma yerleşir; yenileri yer oldukça altına gelir. Ekran sınırında
mevcut bloklar taşınmadan uygun boş alan kullanılır. Ekrana aynı anda sığmayacak
kadar uzun metinlerde en eski blok görsel olarak bırakılır; üst sınır yine üçtür.
Süre çarpanı, konuşma başına okuma süresi ve isim/renkler korunur. Eşdeğer OCR
satır sonu/noktalama değişiklikleri okunmakta olan bloğu yeniden biçimlendirmez.
`test_subtitle_timeline.cjs`, ekleme, süre dolması, sürekli üçlü akış, sınırlar ve
kimliklerin korunmasını konum hesaplarıyla doğrular.

**1.0.38:** API yanıtı gelmeden OCR'nin boş kareye veya henüz çevrilmemiş başka
satıra geçmesi, önceki çevirinin tek başına elenme nedeni değildir. Son görülmesinden
itibaren dört saniye içindeki yanıt, daha yeni bir konuşma zaten gösterilmediyse
ekrana alınır. Kaynağı artık görünmeyen bu sonuç, 10 saniyelik bekçi süresi yerine
metin uzunluğuna ve ekran süresi çarpanına göre tutulur; iki satırın tabanı 2,5 saniyedir.
Yeni satırlar devam eden HTTP isteklerini iptal etmez. İki istek sürdürülür; en fazla
üç satır sırada bekler, 1.500 ms'den eski bekleyen satırlar API'ye gönderilmez.
Oturum/anahtar sıfırlamasında işler iptal edilir; farklı bağlamdaki aynı replik ve
daha yeni gösterilmiş metinler için eski sonuç kullanılmaz. Kota hatası kuyruğu
boşaltır ve `Retry-After` uygulanır.

`videoDiagnostics.video.api`, istek/başarı/hata/gösterim/elenme sayaçlarını, uçuşta
ve sıradaki iş sayısını ve son kararı içerir; anahtar içermez. `lastTextRead` son
gerçek OCR metnini ve güvenini verir. `testTranslation` için `{ "display": true }`,
çalışan akışa etiketli test metni, hemen ardından boş OCR girdisi gönderir. Böylece
Gemini yanıtı, gerçek altyazı aboneliği, okuma süresi ve bulut kaydı aynı yoldan
sınanabilir. Normal Bağlantıyı test et düğmesi bu seçeneği kullanmaz.

**1.0.37:** API yönlendirmesi, `In Spanish` gibi kaynak konuşma dilini bildiren
ifadeler olsa bile Türkçe çıktı ister; bu ifadeler hedef dili değiştirmez.
Gerçek Gemini çağrısında İspanyolca dönen `In Spanish: Let's go!` örneği bu nedenle
ayrı canlı doğrulama örneğidir. `testTranslation` tanılaması isteğe bağlı, en fazla
1.440 karakterlik `text` alabilir; varsayılan test ve kayıt davranışı korunur.

**1.0.36:** Yerel motorun `Unknown Session Request Error` yanıtı, meşgul Remote Play
yanıtı gibi 2/5/10 saniyelik sınırlı yeniden denemeye alınır. Önceden sağlıklı bir
akışın ardından ilk el sıkışması reddedildiğinde okumanın doğrudan sona ermesi
engellenir. Yeni görüntü geldiğinde tanılamadaki eski hata temizlenir. Geçersiz
eşleştirme hataları yeniden denenmez ve ardışık başarısız bağlantı sayısı sınırlıdır.
`test_reconnect.cjs`, önce bu kesintiyi tekrar üretir, sonra çevirinin yeniden
gösterilmesini ve başarısız oturumların sonsuz döngüye girmemesini sınar.

TV, seçili altyazı alanının parlaklık kanalında harf dizisi arar. Uygun karelerde PP-OCRv6 Tiny metin bölgelerini bulur, Latin alfabesine daraltılmış PP-OCRv6 Small bu bölgeleri okur. Tarama seçilen alanın tamamını kullanır. Harf adayı görülmediğinde alan seyrek olarak tekrar taranır. `videoDiagnostics` içindeki `ocrRuns` model çağrılarını, `skippedCrops` model çalıştırmadan atlanan kareleri gösterir. Tanılama kayıtları gri kırpımı içerir.

`native/ocr_image_test.c`, görüntü filtresini TV bağlantısı olmadan sınar. `tools/benchmark_ocr.py`, eski ve yeni `ocr_image` paylaşımlı kütüphanelerini aynı videonun aynı zamanlarında karşılaştırır. Referans metinler yalnızca değerlendirmede kullanılır; OCR metnine düzeltme uygulanmaz. Sekiz geliştirme karesinin zamanları `tools/ocr-scenes.json` içindedir. Kareler FFmpeg ile Y kanalından alınır ve uygulamanın varsayılan alanı kullanılır. Sonuçlar bağımsız bir doğruluk veya TV performans ölçümü değildir.

OLED55CX6LA üzerinde ilk kurulumda HDMI görüntüsünü, ikinci PSN hesabı ile arka plan akışını ve DualSense’i aynı oturumda kontrol et. Ardından Türkçe satırın ekrana gelişini ve satır değişimlerini izle. HDR, VRR ve Oyun Modu durumunu doğrudan HDMI girişindeki sonuçla karşılaştır.

## Yeniden paketleme

ARM motoru bir Debian 12 x86_64 ortamında derlenir. Debian’da `armhf` mimarisini etkinleştir ve aşağıdaki paketleri yükle.

```sh
sudo dpkg --add-architecture armhf
sudo apt-get update
sudo apt-get install cmake ninja-build gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
  git pkg-config protobuf-compiler python3-protobuf python3-onnx libjson-c-dev:armhf libssl-dev:armhf \
  libevent-dev:armhf libminiupnpc-dev:armhf libopus-dev:armhf libjerasure-dev:armhf \
  libgf-complete-dev:armhf libopenh264-dev:armhf libjpeg62-turbo-dev:armhf ca-certificates
bash tv-app/native/prepare-onnxruntime.sh /tmp/gtavi-onnx
bash tv-app/native/build.sh /tmp/gtavi-build /tmp/gtavi-paddle-runtime /tmp/gtavi-onnx/sysroot
```

LG CLI `@webos-tools/cli@3.2.6` içindeki `bin/ares-package.js` ve `dist/subtitle.json.gz` birleşik sözlüğüyle uygulamayı paketle. Paketleyici incelenmiş birleşik dosyanın SHA-256 değerini kontrol eder. Eski CouchSubs v5 kopyası `translations/merge-review/legacy-subtitle.json.gz` içinde değiştirilmeden korunur; kaynak bilgisi birleşik paketin `merge_info.legacy_source` alanında da bulunur.

```sh
npm install --no-save @webos-tools/cli@3.2.6 ws@7.5.10
python tv-app/tools/package.py --runtime /tmp/gtavi-paddle-runtime --pack dist/subtitle.json.gz \
  --cli ./node_modules/@webos-tools/cli/bin/ares-package.js --websocket ./node_modules/ws --output dist
```

## Kaynaklar

- Remote Play motoru [chiaki-ng](https://github.com/streetpea/chiaki-ng/tree/43728af2e639fecb8a7af1cd68c29820a40de973) üzerinden çalışır. Kod AGPL-3.0 lisanslıdır.
- LG HDMI davranışı için [CouchSubs](https://github.com/yorulmazsinan/couchsubs/blob/main/tv-webos/platform.js) ve TV’de Remote Play için [Hotaru](https://github.com/renjfk/hotaru-webos) referans alındı.
- [PaddleOCR PP-OCRv6](https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html) modelleri [ONNX Runtime](https://packages.debian.org/trixie/libonnxruntime1.21) üzerinde çalışır.
- Altyazı paketi CouchSubs kataloğundaki GTA VI v5 paketidir. Paketin kendi kaynak bilgisi arşivde durur.
- Benzerlik araması CouchSubs’un [PackFuzzy v1 biçimini](https://github.com/yorulmazsinan/couchsubs/blob/799a871b46112264986b1e7c11be8fa53036b3b3/core/Sources/CouchSubsCore/PackFuzzy.swift) kullanır. AGPL-3.0 lisanslıdır.
- Kurulum QR kodu MIT lisanslı [qrcode-generator 2.0.4](https://github.com/kazuhikoarase/qrcode-generator) ile çizilir.
- ARM kütüphanelerinin lisans bildirimleri `runtime/licenses` altında paketlenir.

### Birleşik çeviri sözlüğünü yeniden üretme

```sh
python tv-app/tools/build_merged_translation.py
node --test tv-app/tools/test_merged_translation.cjs tv-app/tools/test_ocr_rate.cjs tv-app/tools/test_speaker_names.cjs tv-app/tools/test_key_dedup.cjs tv-app/tools/test_local_context.cjs tv-app/tools/test_reconnect.cjs tv-app/tools/test_quality.cjs
```

Birleştirici önce `dist/merged/subtitle.json.gz` adayını üretir. `translations/merge-review` içindeki bütün farklı ortak karşılıkların kararları eksiksiz olmalıdır; incelenen İngilizce veya Türkçe değişmişse eski karar uygulanmaz. Nihai uzlaştırmalar `final-overrides.json`, aynı anlama gelen kısa karşılıkların bağımsız incelemeleri `collision-decisions-1.json` ve `collision-decisions-2.json`, onaylanmış ortak gösterimler `collision-resolutions.json` içindedir. Aday doğrulandıktan sonra dağıtım kopyası `dist/subtitle.json.gz` ve paketleyicideki SHA-256 birlikte güncellenir.

Tekilleştirilmiş birleşik sözlük biçim 3 kullanır; `entries` ve `segments` değerleri yine Türkçe metindir. Eski biçim-2 paketler güncel uygulamada desteklenir. İngilizce OCR anahtarları ve mevcut benzerlik algoritması kullanılır; birleşen anahtarlar için fuzzy dizini yeniden kurulur. İsimli kayıtlar ve her görünümün renk kanıtı ek `speaker_metadata.records` alanındadır. `speaker_metadata.keys`, eşleşmeyi kaynak kayıtlara bağlar; birden fazla aday varsa tek bir konuşmacı/renk varsayılmaz. Yalnız eski pakette bulunan kayıtlara isim veya renk uydurulmaz. Görünüm varsayılan olarak isimsizdir; **Altyazı görünümü → Konuşmacı isimleri** ile açılır. İsimler çeviri metni üzerinden aranmaz; birebir eşleşme, OCR onarımı ve benzerlik araması bulunan kaynak anahtarını taşır. Birden fazla adayın konuşmacıları uyuşmuyorsa isim eklenmez. Aynı karedeki ayrı konuşmacılar ve farklı renkli iki Polis ayrı isim alanlarıyla çizilir. Ekrana metin düğümleri ve doğrulanmış HEX renkleri aktarılır; paket metni HTML olarak çalıştırılmaz.

Eski bir TV önbelleği yeni birleşik sözlüğü gizlemez. GitHub güncellemesinde birleşik olmayan eski bir paket, yüklenmiş birleşik paketin yerine geçirilmez. `dist/gta-vi-tr/subtitle.json.gz` eski ayrı paketin arşiv kopyasıdır; artık uygulamaya ikinci sözlük olarak eklenmez.

### İsimli/isimsiz arama kayıtlarını tekilleştirme

`tools/compact_translation_keys.py`, yalnız kaynakta doğrulanmış isimli kaydın isimsiz karşılığı mevcutsa ve iki Türkçe değer birebir aynıysa tekrarlanan çeviri girdisini kaldırır. Farklı anlamlar, farklı Türkçe değerler veya belirsiz hedefler birleştirilmez. `name`/`color` gösterimi ve bütün kaynak kare/renk kanıtları ayrı kalır.

Okuyucu, mevcut `speaker_metadata` kayıtlarından isimli OCR biçimini tek ortak girdiye yönlendirir; pakete ikinci bir alias tablosu eklenmez. İsimleri kaçırmayan, iki noktayı okumayan veya satır sonlarını farklı okuyan OCR biçimleri öncekiyle aynı sonucu verir. Benzerlik aramasının skorları ve aday ayrımı değişmesin diye eski imzalar mantıksal okuma yollarıyla birlikte aynen korunur. Bu nedenle fuzzy dizininin sayısı fiziksel çeviri girdilerinden büyük olabilir.

`key_compaction.version=1` düzeni doğrulanır; eksik kaynak, farklı hedef çeviri veya yanlış kayıt sayısı varsa hatalı paket kullanılmaz. Paket biçimi 3 olduğundan eski uygulamalar bunu sessizce eksik okuyamaz. Yeni uygulama, önbellekteki eski birleşik sözlüğün yeni paketlenmiş kopyayı gizlememesi için `merge_info.version` artışlarını da izler (tekilleştirme: 2, yerel bağlam: 3).

`translations/key-dedup/baseline` içindeki değiştirilmeyen önceki sözlük ve okuyucu kodu bağımsız test referansıdır. `test_key_dedup.cjs`, bütün eski anahtarları, isim/renkleri, aynı imzaları ve özgün okuyucuyla eşleştirme sonuçlarını karşılaştırır. `translations/key-dedup/compacted-keys.json` yalnız denetim kaydıdır; uygulamaya ayrı arama sözlüğü olarak eklenmez.

### Yerel konuşma bağlamı

Paket öncelikli modda her oyun akışı son 10 farklı İngilizce okumayı kendi hafızasında tutar. Aynı altyazının tekrarlanan OCR okumaları ve büyüyen aynı cümle iki ayrı güçlü dayanak sayılmaz. İki farklı, yüksek güvenli, doğrudan eşleşmiş önceki replik aynı bölümdeki kaynak konuşma sırasını doğrulamadan belirsiz karşılık veya okunamayan isim seçilmez. Kaynakta isim bulunmuyorsa isim eklenmez; renkler seçilen kaynak görünümünden gelir.

Güvenilir mevcut isimli sonuçlar ve mevcut yaklaşık eşleşmeler aynen korunur. İsim bilgisi bulunmayan birebir sonuçta çeviri güvenliyse metin değişmeden yalnız isim tamamlanabilir. Çözülemeyen okumalar için yerel adaylar en son güçlü kaynak kaydından sonraki 15 kaynak saniyesi/60 kayıt içinde aranır; iki dayanak arasında en fazla 45 kaynak saniyesi/160 kayıt bulunabilir. Kaynak zamanları yalnız komşuluk içindir; oyun saatiyle video dakikası eşleştirilmez.

Güçlü dayanak için en az 24 karakter/4 kelimelik, sansür/okunamayan kelime işareti taşımayan bir kaynak cümlesi ve en az %90 OCR güveni gerekir. Kısa bir belirsiz okuma en az %85 güvenle ele alınır. Yerel yazım benzerliği yalnız mevcut sistem sonuç bulamamışsa, en az %90 OCR güveniyle, en az 16 karakter/3 kelimede ve ayardaki benzerlikten düşük olmayan (en az %92) eşikle denenir. Yakın rakip adaydan en az 5 puan fark gerekir; %100 ayarı yerel yaklaşık aramayı da kapatır.

Aradaki kısa, kaynakta bilinen cevaplar eski bir kayda dönülmesini veto edebilir; kendi başlarına güçlü dayanak olamazlar. Tekrar eden kısa cevap başka konuşmacıya taşınmaz. En az 1,2 saniyelik boşluktan sonra aynı kısa yazının yeniden belirmesi yeni bir konuşma olabilir; önceki isim otomatik tekrar kullanılmaz. Azalan OCR parçaları yeni cevap olarak yorumlanmaz. Bağlamdan kurtarılan sonuçlar sonraki kararlarını doğrulayan güçlü dayanak yapılmaz.

Son güçlü okuma 20 saniyeden eskiyse seçim yapılmaz; 45 saniyelik uzun arada hafıza bırakılır. Konuşma sırası uyuşmazlığı, iki farklı güvenilir ama kaynaksız okuma, durdurma, yeniden bağlantı, altyazı alanı/çeviri ayarı değişimi veya sözlük değişiminde eski bağlam kullanılmaz. İki eşit olasılıklı sahne varsa mevcut eşleştirme/API yedeği sürer. Sıralama verisi olmayan eski paketlerde bağlam devre dışı kalır ve mevcut okuyucu çalışmaya devam eder.

Yerel bağlam internet veya API gerektirmez. API çağrılarının giriş metni/modeli değiştirilmez; önceki replikler API'ye eklenmez. API önbelleği ve bekleyen istek kimliği, aynı kısa cümlenin farklı sahnedeki karşılığını karıştırmamak için oturum/bağlam kapsamında tutulur. İsim/renk alanları çeviri metninden ayrı gönderilmeye devam eder.

`local_context.version=1`, kaynak kayıt kimlikleri ve yaklaşık gezinme zamanlarıyla bölüm sırasını taşır. Eksik veya bozuk isteğe bağlı sıra verisi yalnız bağlam yardımını kapatır; sözlük, OCR onarımı ve isim/renk gösterimi çalışmaya devam eder. `createPackStore().match()` stateless eski yol olarak korunur; oyun akışı `createSession()` ile ayrı hafıza kullanır. Testler için `createSession({enabled:false})` bağlamı kapatır. `videoDiagnostics.contextualPackMatches`, bu yardımla gösterilen sonuçları sayar.

`translations/local-context/baseline` bağlam öncesi bağımsız kod/sözlük referansıdır. `test_local_context.cjs`, bütün kaynak kayıtlarında kapalı/soğuk oturumların aynı sonuç vermesini; isimli ve isimsiz kaynak sırası tekrar oynatmalarını; belirsizlik, ara, tekrar, geri gidiş, oturum ayrımı, renkler ve API önbelleğini doğrular. Yerel tekrar oynatma testleri gerçek TV üzerindeki bütün oynanışlar için doğruluk ölçümü değildir.

### OCR hızı ve çok satırlı eşleştirme

1.0.30'da üst/alt satırları kesebilen `%31–79` iç bant filtresi kaldırıldı; okuma ve aday seçimi kullanıcının belirlediği alanın tamamını kullanır. Varsayılan alan `%77–100` (yatay `%6–94`) olarak kalır; 1.0.28'in eski `%62–100` fabrika alanı bu dar varsayılana geçirilir, diğer özel seçimler korunur. Tek karede en fazla **6 metin bölgesi** okunur ve bölge sınırları satır sonuyla aktarılır. Böylece çok satırlı eşleştirme yedeği canlı OCR çıktısında da kullanılabilir. Algılayıcının 512 piksel sınırı, kare başına tek algılama ve adaysız karelerde seyrek kontrol sürer. Daha fazla yazı içeren alanların işlem maliyeti TV üzerinde ölçülmelidir.

1.0.31’de ekranda en fazla üç konuşma tutulur; yeni konuşma altta görünür. Her konuşmanın okuma süresi uzunluğundan hesaplanır: kısa yanıt yaklaşık 0,5 saniye, iki satır en az 2,5 saniye; uzun metinler daha fazla süre alır. **Altyazı görünümü → Ekranda kalma süresi** çarpanı 0,5×–3× arasında seçilir ve TV’de saklanır. Oyundaki yazı okunmaya devam ettikçe güncel konuşma korunur; yavaş OCR aralarında 1,8 saniyelik erken gizleme yapılmaz. Boş veya eşleşmeyen bir okuma önceki konuşmaları yalnız kendi asgari süreleri dolduysa kaldırır. Durdurma, yeniden bağlantı ve ayar değişimi geçmişi temizler. Hiç yeni sonuç gelmezse 10 saniyelik koruma süresi sonunda görüntü bırakılır. Art arda aynı metinler yeniden eklenmez ve gereksiz çizilmez. `videoDiagnostics.video.timing` içindeki `queueMs` kırpımın OCR kuyruğunda beklemesini, `ocrMs` model işlemesini, `cropAgeMs` kırpım seçiminden sonucun yayımlanmasına kadar geçen süreyi, `matchMs` yerel sözlük/bağlam aramasını gösterir. Her alanın `maxQueueMs`, `maxOcrMs`, `maxCropAgeMs`, `maxMatchMs` karşılıkları oturumdaki en yüksek süreyi tutar. Aynı görüntü tekrar kullanıldığında veya OCR atlandığında `ocrMs` sıfırdır. Bu ölçümler PS5'in görüntüyü oluşturması ile Remote Play'de alınması arasındaki süreyi içermez.

Önce mevcut tam metin, OCR onarımı/benzerlik ve yerel bağlam yolu kullanılır. Sonuç bulunamazsa canlı oturum en fazla 1440 karakterlik, 2–6 fiziksel satırlı okumayı ardışık replik gruplarına ayırarak **yalnız birebir sözlük karşılıklarını** dener. Satıra taşan cümleler grup olarak aranır; tek tek kelime/cümle tahmini yapılmaz. En fazla 21 grup aranır ve 32 bölünme değerlendirilir. Bütün satırlar karşılanmalıdır; okunamayan satırı atıp kısmi çeviri gösterilmez. Tam bloğun bilinen belirsizliği veya farklı tam bölünmelerin farklı anlam/isim üretmesi halinde sonuç seçilmez. Bu yedek yol parçalar üzerinde yaklaşık eşleştirme yapmaz.

Seçilen sözlük çevirileri aynen kullanılır. İsimler ve her kaynak görünümüne ait renkler metinden ayrı taşınır; birleştirme sırasında isimlerin karakter konumları yeni metne göre kaydırılır. Farklı bölünmelerin renkleri uyuşmazsa renk uydurulmaz. Servis yeni bloğa önceki OCR metnini eklemez; arayüz son üç konuşmanın gösterim sürelerini bağımsız yönetir. Birleştirme sonucu yerel bağlam için güçlü dayanak olarak kullanılmaz. `createPackStore().match()` eski 360 karakterlik davranışını korur; uzun blok desteği `createSession()` yolundadır. API isteğinin 360 karakter sınırı ve API giriş/model davranışı değişmez. `videoDiagnostics.multilinePackMatches` birleşik sonuçları sayar.

`tools/test_multiline.cjs`; geçmiş altı satırlı eşleştirme girdilerini, cümle devamlarını, farklı renkli aynı isimleri, eksik/belirsiz grupları, uzun okumaları, isim açık/kapalı gösterimini ve önceki metnin birikmemesini doğrular. `test_quality.cjs` yavaş OCR sırasında altyazının kesintisiz görünmesini, `test_reconnect.cjs` tanılama sürelerinin aktarılmasını sınar. `tools/fixtures/multiline` iki gerçek beş satırlı sahnenin 540p/720p/1080p Y düzlemi karelerini ve 1.0.28 dönemindeki yerel OCR çıktısını içerir. `tools/benchmark_multiline_ocr.py`, seçilen Windows C okuyucusu ve aynı Paddle modelleriyle bu kareleri yeniden işleyebilir; eski geniş alan deneyi için `--region-top 62`, güncel alan için varsayılan `77` kullanılır. `--video` ve `--ffmpeg` ile kareler tekrar üretilebilir. Ölçeklenmiş indirilmiş video kareleriyle yapılan test, TV donanımında Remote Play gecikmesi/doğruluğu ölçümü değildir.


### Görünen konuşmaların API’siz eşleştirilmesi

`turn-index.js`, doğrulanmış çok konuşmalı kaynak kayıtlarından konuşmacı başlıklarıyla ayrılan **tam konuşmaları** çıkarır. Kaydın Türkçe gövdesi seçilmiş sözlük karşılığıyla aynı değilse kayıt kullanılmaz. İngilizce/Türkçe konuşmacı sırası ve sınırlar doğrulanır; yarım satıra veya kelimeye çeviri atanmaz. Aynı İngilizcenin farklı Türkçe karşılıkları varsa seçim yapılmaz. Bu dizin yalnız canlı oturumun mevcut eşleştirmesi sonuç vermediğinde, en az %85 OCR güveniyle ve birebir anahtarla kullanılır; parçalı yaklaşık eşleştirme eklenmez. Böylece varsayılan dar alanda yalnız son iki konuşması görünen Relay sahnesi de API olmadan eşleşir. Bu sonuçlar yerel bağlamın güçlü dayanağı yapılmaz.

### Güncel OCR akışını sınama

`test_subtitle_timeline.cjs`, bağımsız süreleri, üç konuşma sınırını, kayan blokları ve çarpanı; `test_turn_index.cjs`, kaynak sınırlarını ve belirsizlikleri sınar. `test_quality.cjs`, gerçek uygulama kodunda yavaş OCR sırasında görünürlüğü ve ekran koruyucu aboneliğini kontrol eder.

`test_current_ocr.cjs`, hazır OCR metni kullanmaz: mevcut `native/paddle_ocr.c` ve `native/ocr_image.c` dosyalarını yeniden derler, SHA-256 değerlerini kaydeder, gerçek Y düzlemi görüntülerini 540p/720p/1080p’de hem dar hem geniş alanda okur. Üretilen 12 sonuç gerçek sözlük, API’siz servis beslemesi ve üç konuşmalı gösterimden geçirilir. Derleyici, ONNX Runtime C başlıkları, incelenmiş Paddle runtime’ı ve numpy/Pillow içeren Python gerekir. Ortam verilmezse bu donanımsız entegrasyon testi açıkça atlanır; TV performans ölçümü sayılmaz.

```powershell
$env:OCR_RUNTIME = 'C:/path/to/windows-paddle-runtime'
$env:OCR_ONNX_INCLUDE = 'C:/path/to/onnx-headers'
$env:OCR_PYTHON = 'C:/path/to/venv/Scripts/python.exe'
$env:OCR_VCVARS = 'C:/path/to/Visual Studio/VC/Auxiliary/Build/vcvars64.bat'
node --test tv-app/tools/test_current_ocr.cjs
node --test tv-app/tools/test_subtitle_timeline.cjs tv-app/tools/test_turn_index.cjs tv-app/tools/test_quality.cjs
```

Linux’ta `OCR_VCVARS` gerekmez; `CC` ile C derleyicisi seçilebilir.

### OCR okuyucularını karşılaştırma

`tools/compare_ocr.py`, güncel C okuyucusunu derler ve aynı Tiny algılayıcıyla Small Latin, Tiny, Tiny Latin ve İngilizce PP-OCRv5 Mobile okuyucularını karşılaştırır. `onnx`, numpy/Pillow ve yereldeki etiketli `output/ocr/live-samples` kayıtları gerekir. Her kare beş kez, modeller sırayla ve sabit tohumla karıştırılmış düzende okunur; ısınma ve model yükleme süreleri kare süresine katılmaz. Gerçek TV hızını ölçmez.

```sh
python tv-app/tools/compare_ocr.py --runtime PATH_TO_CURRENT_RUNTIME --tiny PATH_TO_TINY_MODEL_FILES --english PATH_TO_ENGLISH_RUNTIME --onnx-include PATH_TO_ONNX_HEADERS --output output/ocr-comparison/comparison.json
```

`compare_ocr.cjs` aynı çıktıları güncel yerel paketle, API ve konuşma bağlamı olmadan eşleştirir. Tiny→Small yedeği, önceden ölçülen tam model çağrılarının süreleri toplanarak değerlendirilir; canlı hibrit uygulaması değildir. Referans Türkçeyle birebir uyuşma ayrı tutulur. İstenirse `--translation-review PATH` ile yalnız kimliği ve iki metni birebir doğrulanan, elle incelenmiş eşdeğer ifadeler ayrıca sayılır; bu inceleme sözlüğü değiştirmez. Referans İngilizcesi bile eşleşmeyen kareler çeviri başarı paydasına alınmaz. JSON raporu ham okumaları, beş tekrarın sürelerini, model/kaynak/görüntü SHA-256 değerlerini ve sonuçları; CSV dosyası özet tabloyu içerir.

### Satır önbelleği ve kuyruk — 1.0.33

Small Latin okuyucusu ve Tiny algılayıcının model dosyaları değişmez. Okuyucuya verilen 48 piksel yüksekliğindeki satırın hazırlanmış tensörü birebir aynıysa önceki İngilizce metin ve güven değeri kullanılır. Gri görüntünün üç kanalı aynı olduğundan ilk kanalın bütün float baytları ve genişlik karşılaştırılır; yaklaşık harf işareti veya yalnız hash eşitliği yeterli değildir. Arka planın satır kutusu dışındaki değişimi tekrar okumayı gerektirmez. Değişen harf, kenar yumuşatma veya satır geometrisi yeni model çağrısı doğurur. Algılama her yeni kırpımda sürer; yeni satır ve silinen satır eski bloktan devralınmaz.

Önbellek 12 satırla sınırlıdır; en eski kullanılan kayıt çıkarılır. Ek görüntü belleği en çok yaklaşık 3,4 MiB’dir. Bellek ayrılamazsa normal OCR devam eder. Önbellek Türkçe çeviriyi veya konuşma bağlamını saklamaz; model/oturum kapanınca bırakılır. İlk kez okunan bir satırın model süresini kısaltmaz; tekrarlanan ve kayan bloklardaki değişmeyen satırların tekrar işlenmesini azaltır.

OCR kuyruğunda aynı boyut, alan sürümü ve bütün kırpım baytları doğrulanan en son kayıt tazelenebilir; ilk görülme sırası korunur. Farklı iki konuşma kaba harf işaretine bakılarak birleştirilmez. Korunmayan eski arka plan kareleri de 1,5 saniye sonunda elenir. Yeni replik başlangıçları arka plan tekrarlarından önce alınır; iki ayrı başlangıcın kendi aralarındaki sıra korunur. `videoDiagnostics.video.ocr`, kullanılan `threads`, gerçek `readerRuns` ve `lineCacheHits` değerlerini; `video.engine`, `expiredCrops` ve `refreshedCrops` sayaçlarını taşır. Bu sayaçlar native motor yeniden başladığında sıfırlanır.

`native/ocr_cache_queue_test.c`, tek bitlik görüntü değişimini, boyutu, LRU çıkarmayı, kuyruk sırasını, tazelemeyi ve eski arka planların elenmesini sınar. Güncel OCR entegrasyon testi bu C testini de derleyip çalıştırır. `tools/test_cache_ocr.py`, gerçek görüntüleri önbellek açık/kapalı okuyarak metin ve güven değerlerini karşılaştırır; aynı satır tekrarları ve tek piksel arka plan değişimleri de denenir. Yerel geniş veri varsa 174 görüntüde 696 karşılaştırma yapılır; yalnız depodaki görüntüler varsa çok satırlı 12 kırpım kullanılır. Bunlar canlı TV gecikmesi ölçümü değildir.

`native/paddle_cpu_probe.c` ve `tools/benchmark_cpu_tv.cjs`, TV’de Small modeli önbellek kapalıyken 1/2/3 iş parçacığıyla karşılaştırmak içindir. Uygulama ölçüm boyunca kapatılır ve sonunda açılır; ölçüme eşzamanlı Remote Play çözümü dahil değildir. OLED55CX6LA üzerindeki 10 görüntü ve ters sıralı iki turda toplam 60 ölçüm yapıldı. Yazılı karelerin ortancası 1 iş parçacığında 3443 ms, 2’de 1886 ms, 3’te 1418 ms oldu; metin ve güven değerleri değişmedi. Bu nedenle varsayılan 3 korunur. Tekrarlanan görüntülerle yapılan önbellek testi ile ilk okuma CPU ölçümü ayrı değerlendirilmelidir.

### Oyun sırasında ekran koruyucu

Oyun oturumu açık ve uygulama ön plandayken `tvpower/power/registerScreenSaverRequest` aboneliği başlatılır; ekran koruyucu isteğine aynı zaman damgasıyla `ack: false` yanıtı verilir. Eski webOS sürümlerinin `state` alanı göndermediği istekler de kabul edilir. Uygulama arka plana geçtiğinde veya oturum kapandığında abonelik bırakılır. Erişim reddedilirse uygulama bunu bildirir. TV’nin genel güç ayarları değiştirilmez.

Mevcut `screenSaverProperties.preferredType: 2` ayarı tek başına ekran koruyucuyu tamamen kapatmaz ([LG açıklaması](https://webostv.developer.lge.com/develop/guides/screensaver)). Abonelik için [webOS uygulaması örneği](https://github.com/zzeppieri/webos-custom-home/blob/main/src/service/luna.ts) temel alındı. Otomatik testler abonelik, zaman damgası yanıtı ve uygulamadan çıkış davranışını doğrular; gerçek TV’de uzun oyun oturumu ayrıca denenmelidir.
