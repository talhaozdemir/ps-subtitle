# GTA VI Türkçe Altyazı kurulum rehberi

## Kurulumdan önce

TV, bilgisayar ve PS5 aynı yerel ağda olsun. PS5’i HDMI ile TV’ye bağla. LG geliştirici hesabını ve PS5’te oturum açabileceğin ikinci PSN hesabını hazırla. Kullanacağın paket `com.gtavi.turkce_1.0.2_all.ipk`. Projede `dist` klasöründe bulunur.

## TV’yi hazırla ve IPK’yi yükle

1. **TV’de Developer Mode’u aç.** LG Apps’ten **Developer Mode** uygulamasını kur ve LG geliştirici hesabınla giriş yap. **Dev Mode Status** seçeneğini aç. TV yeniden başlayacak. [LG Developer Mode rehberi](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
2. **TV’nin IP adresini ve kodunu al.** TV açılınca **Developer Mode** uygulamasına dön. **Key Server**’ı aç ve ekranı açık bırak. TV’nin IP adresini ve **6 karakterli Passphrase** kodunu kullanacaksın.
3. **Dev Manager ile TV’ye bağlan.** Windows için `x64_en-US.msi`, macOS için `universal.dmg` sürümünü kur. **Add Device** ekranında TV’nin IP adresini **Host Address** alanına, TV’deki kodu **Passphrase** alanına gir ve **Add**’e bas. [Dev Manager’ı indir](https://github.com/webosbrew/dev-manager-desktop/releases/latest)
4. **Uygulamayı TV’ye yükle.** Dev Manager’da TV’yi seç. **Apps → Install** düğmesiyle IPK dosyasını aç. Yükleme tamamlanınca TV’nin ana ekranından **GTA VI Türkçe Altyazı** uygulamasını başlat.

**Yükleme yöntemi.** Dev Manager dosyayı seçerek yüklemeyi kolaylaştırır. Resmî webOS CLI ile sonraki IPK’leri tek komutla yükleyebilir ve hata çıktısını terminalde görebilirsin. İki yöntem de aynı IPK’yi yükler.

**TV uyumu.** Prototip LG CX (OLED55CX6LA, webOS 5) hedeflenerek hazırlandı. LG C6 (OLED65C64LA, webOS 26) üzerinde HDMI ve altyazı motoru için cihaz doğrulaması bekliyor.

**Developer Mode süresi.** Süre dolmadan TV’de Developer Mode’u açıp **Extend** ile uzat. Geliştirici modu kapanırsa bu yolla yüklenen uygulamalar kaldırılır.

## Resmî webOS CLI ile yükleme

Bilgisayarda **Node.js ve npm** kurulu olsun. IPK dosyasını bilgisayarına kopyala ve terminali dosyanın bulunduğu klasörde aç. TV’de **Dev Mode Status** ve **Key Server** açıkken aşağıdaki komutları işlet. `ares-novacom` sorunca TV’deki **Passphrase** kodunu gir. [LG CLI kurulumu](https://webostv.developer.lge.com/develop/tools/cli-installation) · [LG CLI komutları](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)

### Windows PowerShell

```powershell
npm.cmd install -g @webos-tools/cli
ares-config.cmd --profile tv
$tvIp = Read-Host "Developer Mode ekranındaki TV IP adresi"
ares-setup-device.cmd --add lgtv -i "host=$tvIp" -i "port=9922" -i "username=prisoner"
ares-novacom.cmd --device lgtv --getkey
ares-install.cmd --device lgtv ".\com.gtavi.turkce_1.0.2_all.ipk"
ares-launch.cmd --device lgtv com.gtavi.turkce
```

### macOS Terminal

```bash
npm install -g @webos-tools/cli
ares-config --profile tv
printf '%s\n' 'Developer Mode ekranındaki TV IP adresini yaz'
read -r tvIp
ares-setup-device --add lgtv -i "host=$tvIp" -i "port=9922" -i "username=prisoner"
ares-novacom --device lgtv --getkey
ares-install --device lgtv "./com.gtavi.turkce_1.0.2_all.ipk"
ares-launch --device lgtv com.gtavi.turkce
```

**Sonraki güncellemeler.** TV bu bilgisayarda zaten kayıtlıysa `ares-install` ile yeni IPK’yi yükle. `lgtv` örnek cihaz adıdır. TV’yi başka bir adla eklediysen komutta o adı kullan.

## PS5’i eşleştir ve altyazıyı dene

5. **İkinci hesapla Uzaktan Oynama’yı aç.** PS5’te ikinci PSN hesabına geç. **Ayarlar → Sistem → Uzaktan Oynama** bölümünde bu kullanıcı için Uzaktan Oynama’yı etkinleştir. [PlayStation ayarları](https://www.playstation.com/tr-tr/support/games/remote-play-settings/)
6. **Hesap kimliğini ve eşleştirme kodunu hazırla.** Hesap kimliği sayfasında ikinci PSN hesabının kullanıcı adını yaz ve **Submit**’e bas. **Encoded ID** değerini sondaki `=` işaretiyle birlikte kopyala. PS5’te **Cihazı Eşleştir** ekranından yeni **8 haneli kodu** al. [PSN hesap kimliği sayfası](https://psn.flipscreen.games/)
7. **TV uygulamasında PS5’i eşleştir.** PS5’in HDMI girişini seç. **PS5’i bul** ile konsolu ara veya IPv4 adresini elle gir. Adresi PS5’te **Ayarlar → Sistem → Sistem Yazılımı → Konsol Bilgileri** bölümünde bulabilirsin. Hesap kimliğini ve 8 haneli kodu yazıp **PS5’i eşleştir** düğmesine bas.
8. **Ana hesabınla oyunu aç.** DualSense PS5’e bağlıyken ana hesabına geç ve oyunda İngilizce altyazıyı etkinleştir. TV’de **Altyazıyı dene** düğmesine bas. Bağlantı kurulunca **Kurulumu bitir**’i seç. Sonraki açılışlarda altyazı kayıtlı ayarlarla başlar. Ayarlara kumandadaki **Geri** tuşuyla dönebilirsin.

### iPhone veya bilgisayardan ayar girme

TV’de **Başka cihazdan doldur**’a bas. iPhone’da QR kodunu okut veya bilgisayarda TV’de gösterilen adresi açıp kurulum kodunu gir. Formu gönder ve TV’de **Uygula**’yı seç. PS5, görüntü ve çeviri ayarlarını aynı formdan girebilirsin. Gemini ve OpenAI anahtarları isteğe bağlıdır.

### İlk denemede sorun olursa

- **TV bulunamıyor.** Bilgisayar ve TV aynı ağda olsun. TV’nin IP adresini doğrula ve **Key Server**’ı açık tut.
- **PS5 eşleşmiyor.** İkinci hesap için Uzaktan Oynama’nın açık olduğunu doğrula. Aynı hesabın kimliğini ve yeni bir 8 haneli kodu kullan.
- **Oyun veya altyazı görünmüyor.** Önce doğru HDMI girişini seç. Görüntü varsa İngilizce altyazının açık olduğunu kontrol et. Yazı küçükse **720p** okumayı dene.

**Altyazı paketi.** Uygulama gömülü paketle gelir. Yeni yayımlanan paketi TV’de **Altyazı paketini güncelle** düğmesiyle alabilirsin. [Altyazı paketi yayınları](https://github.com/talhaozdemir/ps-subtitle/releases)
