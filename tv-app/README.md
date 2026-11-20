# GTA VI Türkçe Altyazı

OLED55CX6LA ve webOS 5 hedeflenerek hazırlanmış ilk TV prototipi. Uygulama PS5’in HDMI görüntüsünü gösterir. TV içindeki Remote Play alıcısı İngilizce altyazıyı okur. Türkçe karşılığı uygulamaya gömülü paketten bulunur.

## Kurulum

1. LG Content Store’dan **Developer Mode** uygulamasını aç, LG geliştirici hesabıyla modu etkinleştir ve **Key Server**’ı aç.
2. Bilgisayarda [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) ile TV’yi ekle. TV’nin gösterdiği kodu kullanıp `com.gtavi.turkce_1.0.1_all.ipk` dosyasını kur.
3. PS5’te ikinci bir PSN hesabıyla oturum aç. **Ayarlar → Sistem → Uzaktan Oynatma** bölümünde Uzaktan Oynatma’yı aç ve **Cihazı Bağla** ekranından 8 haneli kodu al.
4. TV ile PS5’i aynı ev ağına bağla. LG uygulaması ilk açılışta **HDMI** sekmesini gösterir. TV tek bir girişi PS5 olarak tanıyorsa o port otomatik seçilir. Gerekirse portu elle seç ve **PS5** sekmesinde **PS5’i bul** düğmesine bas. Konsol listelenmezse IPv4 adresini elle gir. İkinci hesabın sayısal veya Base64 PSN hesap kimliğini ve ekrandaki kodu gir, ardından **PS5’i eşleştir** düğmesine bas. [PSN hesap kimliği arama sayfası](https://psn.flipscreen.games/)
5. **Altyazı** adımında PS5’te ana hesabına dön, İngilizce oyun altyazısını aç ve **Altyazıyı dene** düğmesine bas. Bağlantı kurulunca **Kurulumu bitir** ile tamamla. Sonraki açılışlarda uygulama kayıtlı ayarlarla altyazıyı başlatır.

Oyun sırasında ayarlara LG kumandasındaki **Geri** tuşuyla dönülür. İlk tarama çözünürlüğü 540p. Oyun yazısı okunamayacak kadar küçük kalırsa 720p denenebilir. Uygulama altyazı başlarken eşleştirilmiş PS5’i ağda arar ve IP adresi değişmişse yeni adresi kaydeder. PS5’i bulamazsa son kayıtlı adresi dener. Bu özellik eklenmeden önce eşleştirilen konsolları bir kez yeniden eşleştirerek otomatik adres güncellemesini etkinleştir.

### Altyazı alanı

İngilizce bir altyazı ekrandayken **Geri → Altyazı alanı** menüsünü aç. Kutuyu yön tuşlarıyla taşı, **OK** ile boyutlandırmaya geç. Sol ve sağ tuşlar genişliği, yukarı ve aşağı tuşlar yüksekliği değiştirir. Magic Remote işaretçisiyle kutuyu veya boyutlandırma köşesini sürükleyebilirsin.

Remote Play bağlıyken kutudan okunan İngilizce metin üstte görünür. En uzun iki satırın etrafında pay bırak. **OK** alanı kaydedip oyuna döner, **Geri** önceki ayara döner. Kayıt sonraki açılışta da kullanılır.

### Altyazı görünümü

Kumandada **Geri → Altyazı görünümü** menüsünü aç. Türkçe altyazıyı alt veya üst ortaya alabilir, seçili kenardan uzaklığını ekran yüksekliğinin %0–30’u arasında ayarlayabilirsin. Yazı boyutu 24–64 px arasında değişir. Siyah arka planı açıp kapatabilir ve açıkken opaklığını %0–100 arasında ayarlayabilirsin.

Kumandanın yukarı ve aşağı tuşlarıyla ayar seç, sol ve sağ tuşlarıyla kaydırıcıları değiştir. Örnek altyazı değişiklikleri anında gösterir. **Kaydet** seçimleri TV’de saklar.

### GitHub’dan altyazı güncelleme

1. [Altyazı reposuna](https://github.com/talhaozdemir/ps-subtitle) ilk commit’i ekle. Boş repoda bir README yeterli.
2. [Yeni yayın oluştur](https://github.com/talhaozdemir/ps-subtitle/releases/new). Örneğin `pack-v5` etiketi seç, `dist/subtitle.json.gz` dosyasını yayın eki olarak yükle ve normal yayın olarak yayımla.
3. TV’de **Geri → Altyazı paketini güncelle** seçeneğine bas. Dosya doğrulanıp TV’ye kaydedilince yeni çeviriler mevcut oturumda devreye girer.

Sonraki yayınlarda aynı `subtitle.json.gz` dosya adını kullan. Paket `gta-6` kimlikli CouchSubs biçim 2 olmalı. TV, GitHub’ın dosya boyutu ve SHA-256 bilgisini kontrol eder. Sorun olursa son çalışan kopya devrede kalır. Paket indirmek için internet bağlantısı gerekir.

## Prototip doğrulaması

OLED55CX6LA üzerinde ilk kurulumda HDMI görüntüsünü, ikinci PSN hesabı ile arka plan akışını ve DualSense’i aynı oturumda kontrol et. Ardından Türkçe satırın ekrana gelişini ve satır değişimlerini izle. HDR, VRR ve Oyun Modu durumunu doğrudan HDMI girişindeki sonuçla karşılaştır.

## Yeniden paketleme

ARM motoru bir Debian 12 x86_64 ortamında derlenir. Debian’da `armhf` mimarisini etkinleştir ve aşağıdaki paketleri yükle.

```sh
sudo dpkg --add-architecture armhf
sudo apt-get update
sudo apt-get install cmake ninja-build gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
  git pkg-config protobuf-compiler python3-protobuf libjson-c-dev:armhf libssl-dev:armhf \
  libevent-dev:armhf libminiupnpc-dev:armhf libopus-dev:armhf libjerasure-dev:armhf \
  libgf-complete-dev:armhf libopenh264-dev:armhf libtesseract-dev:armhf tesseract-ocr-eng
bash tv-app/native/build.sh /tmp/gtavi-build /tmp/gtavi-runtime
```

LG CLI `@webos-tools/cli@3.2.6` içindeki `bin/ares-package.js` ve CouchSubs GTA VI paketinin v5 kopyasıyla uygulamayı paketle. Paketleyici v5 için katalogdaki SHA-256 değerini kontrol eder. [CouchSubs oyun paketi](https://couchsubs-packs.enmera.workers.dev/v1/packs/gta-6)

```sh
python tv-app/tools/package.py --runtime /tmp/gtavi-runtime --pack dist/subtitle.json.gz \
  --cli ./node_modules/@webos-tools/cli/bin/ares-package.js --output dist
```

## Kaynaklar

- Remote Play motoru [chiaki-ng](https://github.com/streetpea/chiaki-ng/tree/43728af2e639fecb8a7af1cd68c29820a40de973) üzerinden çalışır. Kod AGPL-3.0 lisanslıdır.
- LG HDMI davranışı için [CouchSubs](https://github.com/yorulmazsinan/couchsubs/blob/main/tv-webos/platform.js) ve TV’de Remote Play için [Hotaru](https://github.com/renjfk/hotaru-webos) referans alındı.
- Altyazı paketi CouchSubs kataloğundaki GTA VI v5 paketidir. Paketin kendi kaynak bilgisi arşivde durur.
- ARM kütüphanelerinin lisans bildirimleri `runtime/licenses` altında paketlenir.
