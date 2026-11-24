# LG TV'de görüntü yakalama ve OCR araştırma notları

Son güncelleme **25 Kasım 2026**. Önceki TV ölçümleri ağırlıklı olarak 21 Kasım 2026 tarihlidir. Kurulu servisin paylaşımlı bellekten yakalama izni 24 Kasım’da, HTTPS ile bant çözmenin birleşik etkisi 25 Kasım’da aynı TV’de sınandı.

## Amaç ve sonuç

Amaç, PS5'in HDMI görüntüsündeki İngilizce altyazıları LG TV üzerinde OCR'ye verip çevirmek; mümkünse Remote Play, sürekli açık PC ve root gerektirmeden çalışmaktı.

Şu ana kadar doğrulanan iki kullanılabilir görüntü kaynağı Remote Play ve `executeOneShot` üzerinden ekran görüntüsü alma oldu. Eşit koşullardaki kısa OCR testinde toplam TV işlemci kullanımları birbirine yakındı. Remote Play'in yerel kare seçimi–OCR sonucu süresi daha düşüktü; `executeOneShot` ise video akışını sürekli çözme gereksinimi olmadan, her istekte ayrı yakalama maliyeti getiriyordu.

Donanımsal video oynatma yolu çalıştırılabildi. Donanımın çözdüğü ham kareleri OCR'nin okuyabileceği belleğe aktarma yolu henüz doğrulanmadı. HDMI yakalama tarafında ise 04.64.00 firmware’inde kaynak dikdörtgeninin IPP3 donanımına kadar ulaştığı gösterildi. PS5 görüntüsünden ilk kareyle birlikte yalnızca altyazı bandını veren bir TV denemesi henüz yok. [IPP3 incelemesi](#ipp3-ile-yakalama-öncesi-kırpma)

Kurulu `com.gtavi.turkce.altyazi` servisi kendi kimliğiyle yakalama oturumu açmayı denediğinde TV ilk `createHandle` çağrısını izin hatasıyla reddetti. Eşleştirilmiş ekran görüntüsü yoluyla alınan JPEG’lerde kalıcı HTTPS bağlantısı ve yalnızca altyazı bandını çözme birlikte denenebildi. [Paylaşımlı bellek deneyi](#tam-kareyi-dosyasız-alıp-altyazı-bandını-bellekte-kırpmak) · [Kayıtlı replikle karşılaştırma](#aynı-oyun-repliğinde-ingilizceden-türkçeye-gecikme)

## Kapsam, kanıt düzeyleri ve cihaz

Bu notlarda üç durum ayrıdır:

- **Ölçüldü:** TV'de deney yapıldı ve yerel kayıt üretildi.
- **Statik inceleme:** Firmware, sürücü veya LG kaynak kodunda ilgili yol görüldü; bu, yolun mevcut izinlerle çalıştırıldığı anlamına gelmez.
- **Açık konu:** Gerekli izin, yaşam döngüsü, bellek sahipliği veya gerçek çalışma henüz doğrulanmadı.

İncelenen cihaz ve yazılım:

| Alan | Değer |
| --- | --- |
| TV | LG OLED55CX6LA |
| SoC | O20_DVB |
| Firmware | 04.64.00; EPK sürümü 04.64.00.01 |
| OTA kimliği | HE_DTV_W20O_AFABABAA |
| webOS | 5.6.2-21 |
| Kernel | 4.4.84-219.jcl4tvmr.6 |
| Mimari | ARM64 kernel, ARM32 kullanıcı alanı |

Bu sonuçlar bütün LG modellerine veya sonraki firmware sürümlerine genellenmemeli. Yerel IP adresleri, hesap/PSN kimlikleri ve bağlantı anahtarları bu belgeye alınmadı.

## Remote Play ile executeOneShot karşılaştırması

### Eşit OCR koşullarındaki ölçüm

İlk karşılaştırmada Remote Play tarafında video çözme ve OCR varken `executeOneShot` tarafında yalnızca yakalama/indirme vardı. Bu nedenle ilk sayılar eşit iş yükü karşılaştırması olarak kullanılmadı. Ardından aynı OCR koşullarıyla ayrı test yapıldı.

İkinci testin koşulları:

- Her iki kaynakta 960×540 görüntü, 1000 ms OCR aralığı ve aynı benchmark ikilisi, `paddle_ocr.c` ve kurulu PP-OCR modelleri.
- Seçilen her karede OCR zorlandı; çeviri kapalıydı.
- OCR bölgesi yüzde olarak x=19, y=72, genişlik=62, yükseklik=27; oluşan bölge 596×147 piksel.
- Yakalama, TV üzerindeki HTTP indirme, JPEG çözme ve OCR TV'de çalıştı. PC yalnızca deneyi yönetti ve telemetri topladı.
- Kullanıcının tercihiyle mevcut PS5 ekranı kullanıldı; gerçek diyalog altyazısı veya zaman damgalı test görüntüsü sabitlenmedi.

| Ölçüt | executeOneShot + OCR | Remote Play + OCR |
| --- | ---: | ---: |
| Kaynak ölçüm süresi | 28,33 sn | 28,20 sn |
| Başarılı OCR çağrısı | 30/30 | 29/29 |
| Gerçekleşen OCR sıklığı | 1,00/sn | 0,99/sn |
| Toplam TV CPU | %22,33 | %21,50 |
| İzlenen süreçlerin ortalama RSS toplamı | 64,06 MiB | 82,53 MiB |
| Yerel OCR/decoder sürecinin ortalama RSS'i | 36,51 MiB | 57,69 MiB |
| Ortalama sistem kullanılabilir belleği | 634,59 MiB | 616,02 MiB |
| Ortalama görüntü çözme süresi | 20,90 ms JPEG | 6,90 ms; kayıtta ölçülen decoder bölümü |
| Ortalama OCR süresi | 169,13 ms | 176,10 ms |
| OCR süresi p95 | 188 ms | 193 ms |
| Ortalama yerel tur başlangıcı → sonuç | 577,20 ms | 191,03 ms |
| Yerel tur başlangıcı → sonuç p95 | 646 ms | 221 ms |

CPU yüzdelerinde **dört çekirdeğin toplam kapasitesi %100** kabul edildi. Boşta toplam CPU yaklaşık %6,2–6,7 idi. Süreç RSS toplamları paylaşılan sayfaları birden fazla sayabilir; bunlar bütün TV'nin bellek tüketimi değildir.

`executeOneShot` tarafında ortalama yakalama 334,49 ms, TV içindeki HTTP indirme 52,21 ms, JPEG çözme 20,90 ms idi. JPEG çözmeyi kaldırmak yaklaşık 21 ms'lik kısmı hedefler; tek başına yaklaşık 577 ms'lik bütün turu ortadan kaldırmaz.

**Gecikme sınırı:** `executeOneShot` turu ekran görüntüsü isteğinde, Remote Play turu ise yerel kare seçme zamanında başlar. Remote Play'in PS5 kodlama, ağ iletimi ve karenin önceden yaşlanma süresi bu 191 ms'ye dahil değildir. Dolayısıyla bu tablo konsol görüntüsünden çeviriye uçtan uca gecikmeyi kanıtlamaz.

Seçilen bölgede iki yöntemde de OCR boş metin döndürdü. Çağrıların başarılı olması gerçek altyazı tanıma doğruluğu anlamına gelmez. Deney kısa sürdü; uzun oyun oturumu, ısı ve enerji tüketimi ölçülmedi. Bu sonuçlar 333 ms ayarının yük ölçümü olarak da kullanılmamalı; burada aralık 1000 ms idi.

Kanıt: [Eşit OCR testi özeti](../output/hdmi-capture/fair-ocr/run-2026-11-21T13-05-38-360Z/summary.json).

### Pratik değerlendirme

Bu testin koşullarında Remote Play, OCR için hazır kareye ulaşma bakımından daha elverişli görünüyor. Bunun karşılığında PS5 bağlantısı ve sürekli video akışı/çözme yükü var. `executeOneShot`, HDMI dahil TV'de görünen kaynaktan örnek alabilmesiyle esnek; fakat her örnekte yakalama maliyeti yüksek. Onun da toplam CPU'su eşit OCR testinde belirgin biçimde daha düşük çıkmadı.

`executeOneShot` sürekli ve sınırsız sıklıkta çalıştırılırsa ek yük oluşturur. Kısa ölçüm, TV'ye zarar verdiğini veya uzun süre sorunsuz çalışacağını göstermiyor. İstenen OCR sıklığına göre örnekleme yapmak mantıklı; yüksek sıklıkta işlem süresiyle çakışma ve birikme ayrıca kontrol edilmeli.

## OCR sıklığı: 500 ms, 333 ms ve 10 kademeli ayar

Gelen yaklaşık 30 FPS akıştaki bütün kareler OCR'den geçirilmiyor. Kare akışı/çözme ile OCR örnekleme sıklığı ayrı konular.

Belgeleme sırasında mevcut kodda `tv-app/service/settings.js` varsayılan `defaultOcrRate=3`. `tv-app/native/engine.c` aralığı şu formülle hesaplıyor:

```c
interval_ms = (1000 + rate / 2) / rate;
```

Geçerli ayar 1–10; geçersiz değer varsayılana dönüyor. Ayar saniyedeki hedef/üst örnekleme sıklığını ifade ediyor:

| Kademe | Yaklaşık aralık |
| --- | ---: |
| 1 | 1000 ms |
| 2 | 500 ms |
| 3 — varsayılan | 333 ms |
| 4 | 250 ms |
| 5 | 200 ms |
| 6 | 167 ms |
| 7 | 143 ms |
| 8 | 125 ms |
| 9 | 111 ms |
| 10 | 100 ms |

333 ms, bir OCR işleminin mutlaka 333 ms'de tamamlanacağı veya saniyede üç yeni çeviri çıkacağı anlamına gelmez. İşlem süresi ve metin değişimi gibi koşullar gerçekleşen hızı etkiler. OCR sıklığını azaltmak OCR maliyetini düşürebilir; sürekli video çözmenin maliyetini aynı oranda düşürmez.

### Remote Play FPS isteğini düşürme deneyi

960×540, 1000 ms OCR aralığı, çeviri kapalı ve `frameDropping=false` koşullarında:

| İstenen FPS | Gelen FPS | Çözülen FPS | Toplam CPU | Native süreç RSS |
| --- | ---: | ---: | ---: | ---: |
| 15 | 29,97 | 30,02 | %21,21 | 57,27 MiB |
| 5 | 29,96 | 29,96 | %21,16 | 57,56 MiB |

Bu istemci/PS5 denemesinde FPS talebini azaltmak gerçek akışı düşürmedi. Yaklaşık 18 saniyelik her denemede 18 OCR çağrısı yapıldı. Dolayısıyla mevcut yolda yalnızca bu parametreyi değiştirmek decoder yükünü azaltan bir çözüm olmadı.

Kanıt: [FPS deneyi](../output/hdmi-capture/fair-ocr/fps-2026-11-21T13-27-46-486Z/results.json).

## WASM ve donanımsal video çözme

İncelenen OCR/decoder yolu native C motoru ve PaddleOCR kullanıyor; bu yolun OCR'si tarayıcı WASM'i olarak çalışmıyor. WASM'e taşımak otomatik olarak hızlanma veya daha düşük CPU sağlamaz; aynı algoritma ve koşullarda karşılaştırmalı ölçüm yapılmadı. WASM, donanımsal video çözmeyle aynı şey değil.

HDMI kaynağı gerektirmeden üretilmiş yerel H.264 1280×720, 30 FPS, 180 karelik akışla native `NDL DirectMedia` yolu denendi. Gerekli semboller bulundu; yükleme/oynatma durumları olumlu, 180 kare kabul edildi ve reddedilen kare kaydedilmedi. Besleme yaklaşık 5967 ms sürdü.

Bu, donanımsal oynatma yolunun kullanılabildiğini destekliyor. **OCR için CPU tarafından okunabilir ham kare çıkışı elde edildiğini göstermiyor.** Besleyici CPU süresi bütün donanım/TV maliyeti olarak yorumlanmamalı. Diğer yakalama denemelerindeki bellek hatalarıyla da tek bir sorunsuz testmiş gibi birleştirilmemeli.

Kanıt: [Native decoder deneyi](../output/hdmi-capture/hw-decode/native-report.json).

## Altyazı bölgesi, ölçekleme ve gerçek kaynak kırpması

OCR'den önce yazılımda altyazı bölgesini kırpmak mümkün. Ancak bu, TV'nin yakalama biriminin yalnızca o kaynak bölgesini okuduğunu göstermez.

### Küçültülmüş çıktı ölçümleri

YouTube görüntüsünde 24 bit BMP çıktıyla, her boyutta altı tekrar ve bir ısınma örneği dışlanarak yapılan ölçüm:

| Çıktı | Ortalama execute RPC | Karşılık gelen yaklaşık hız | Dosya boyutu |
| --- | ---: | ---: | ---: |
| 960×540 | 349,82 ms | 2,86/sn | 1.555.254 bayt |
| 640×360 | 269,62 ms | 3,71/sn | 691.254 bayt |
| 480×270 | 237,48 ms | 4,21/sn | 388.854 bayt |
| 320×180 | 213,20 ms | 4,69/sn | 172.854 bayt |

Bu süreler yalnızca execute RPC içindir; dosya okuma, kopyalama ve OCR dahil değildir. 320×180 çıktıda süre yaklaşık %39 azaldı. Küçülen, **tüm görüntüydü**. Küçük altyazıların OCR doğruluğuna etkisi aynı gerçek altyazıyla ölçülmedi.

`region`, x/y alanları, `setClipRegions` ve benzeri istekler başarı döndürebildi; fakat çıktı incelendiğinde gerçek kaynak kırpması görülmedi. Örneğin 596×147 çıktı, altyazı bandının alınması yerine tüm ekranın bu boyuta sıkıştırılması olabiliyordu. Yaklaşık 211–228 ms'lik bu tekil sonuçlar gerçek ROI yakalama performansı olarak sunulmamalı.

Kanıt: [Boyut karşılaştırması](../output/hdmi-capture/region-benchmark/analysis.json), [ilk bölge denemeleri](../output/hdmi-capture/fair-ocr/roi-probe/results.json).

### Tam kareyi dosyasız alıp altyazı bandını bellekte kırpmak

PS5 ile denenmiş JPEG yolunda uygulama, TV içindeki HTTP yanıtını bellekten yerel OCR işlemine aktarıyor. Bu işlem JPEG’i bellekten çözüp yalnızca seçilen bandı OCR’ye veriyor. Uygulamanın bu aşamada ikinci bir görüntü dosyası oluşturması gerekmiyor. İlk yakalamada görüntü dosyasının da oluşmaması için yakalama servisinin bellek çıkışına erişim gerekiyor. [JPEG aktarımı](../output/hdmi-capture/fair-ocr/benchmark-service.js#L40) · [Bellekte çözme ve kırpma](../output/hdmi-capture/fair-ocr/benchmark-engine.c#L724)

OLED55CX6LA’nın 04.64.00 firmware’inde yakalama servisi, tam kareyi istemcinin önceden oluşturduğu ve boyutlandırdığı POSIX paylaşımlı bellek nesnesine yazabiliyor. Oturumlu yakalama yolunda `setOutput` bellek adını ve boyutunu alıyor. Servis bu nesneyi açıp belleğe eşliyor ve seçilen görüntü biçimini doğrudan bu alana yazıyor. Sıkıştırmasız 24 bit BMP seçilirse 960×540 kareden (182, 388) konumundaki 596×147 bandın satırlarını okuyup yalnızca bu pikselleri gri tona çevirerek PaddleOCR’ye vermek mümkün. Bu tasarımda tam karenin yakalanması ve BMP’ye dönüştürülmesi sürüyor. [Belleğe yazan firmware kodu](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/memory-output-disasm.txt#L425) · [BMP kodlayıcısı](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/memory-output-bmp.txt#L2) · [PaddleOCR’nin bellek girdisi](../tv-app/native/paddle_ocr.c#L403)

**24 Kasım’da servis kimliğiyle yapılan canlı deneme.** OLED55CX6LA’da PS5, HDMI 3’e bağlıyken kurulu 1.0.40 sürümüne geçici bir tanılama metodu eklendi. Bu metot mevcut `com.gtavi.turkce.altyazi` servis nesnesiyle çalıştı (UID 6224). TV, `createHandle` çağrısına 10,82 ms’de `Denied method call "createHandle" for category "/"` ve hata kodu `-1` döndürdü. Yakalama oturumu açılmadığı için `setOutput` ve `execute` aşamalarına geçilmedi. Bu kimlikle ortak bellekten kare alınamadı ve aynı PS5 sahnesinde HTTP ile OCR süresi karşılaştırılamadı. Özgün uygulama geri yüklendi. Uygulamanın ve servisinin 115 dosyası test öncesindeki SHA-256 değerleriyle eşleşti. [TV yanıtı](../output/hdmi-capture/named-shm-tv/package-live-result.json#L9) · [Geri yükleme kontrolü](../output/hdmi-capture/named-shm-tv/production-after.json)

Önceki rootsuz geliştirici oturumu ayrı bir kimlikle dosyaya JPEG ve BMP yakalayabilmişti. `capture.client` herkese açık bir izin olarak tanımlanmamış ve varsayılan Developer Mode sertifikasında bulunmuyor. Önceki yerel BMP deneyinde dosya `/tmp` altındaydı. Firmware hem `/tmp` hem de `/dev/shm` için `tmpfs` kullanıyor. [Önceki yakalama kaydı](../output/hdmi-capture/rootless-access/broker-report.json#L12) · [İzin grubu](../output/hdmi-capture/firmware-analysis/dvb/driver/broker-access/usr/share/luna-service2/groups.d/com.webos.service.capture.groups.json#L6) · [Developer Mode sertifikası](../output/hdmi-capture/firmware-analysis/dvb/driver/broker-access/usr/share/luna-service2/devmode_certificate.json#L2) · [Firmware bağlama tablosu](../output/hdmi-capture/firmware-analysis/dvb/driver/broker-access/etc/fstab#L6)

**Gecikme.** PS5 ile alınan 30 JPEG örneğinde OCR zaten yalnızca 596×147 bandı işliyordu. İstekten OCR sonucuna ortalama 577,20 ms geçti. Aynı JPEG kullanılır, diğer süreler sabit kalır ve TV içindeki 52,21 ms’lik HTTP aktarımının tamamı kaldırılırsa hesap 524,99 ms olur. Bu, aktarımın katkısını gösteren bir tahmindir. BMP seçmek 20,90 ms’lik JPEG çözmeyi de kaldırır, ancak tam BMP üretme, belleğe yazma ve bandı gri tona dönüştürme maliyetleriyle aynı PS5 sahnesinde karşılaştırma yapılmadı. [PS5 ölçümü](../output/hdmi-capture/fair-ocr/run-2026-11-21T13-05-38-360Z/summary.json#L93)

Ayrı YouTube denemesinde 960×540 BMP yakalama altı örnekte ortalama 349,82 ms, yerel dosyayı okuma 3,28 ms sürdü. Başka bir tek karede, tam BMP belleğe geldikten sonra 596×147 bandın satırlarını kopyalamak ve BMP başlığını hazırlamak 2,63 ms sürdü. Bandın pikselleri referansla birebir eşleşti. Bu son süre gri tona dönüştürmeyi ve OCR’yi içermiyor. Dosya yolu ve paylaşımlı bellek yolu aynı koşullarda çalıştırılıp karşılaştırılana kadar net gecikme kazancı bilinmiyor. [Yerel BMP süreleri](../output/hdmi-capture/region-benchmark/analysis.json#L8) · [Kırpma süresi](../output/hdmi-capture/crop-schema/report.json#L408) · [Piksel denetimi](../output/hdmi-capture/crop-schema/pixel-validation.json#L2)

### Rootsuz HDMI yakalamasında HTTPS bağlantısını yeniden kullanma

PS5 HDMI 3’te ve canlı altyazı açıkken eşleştirilmiş `tv/executeOneShot` yoluyla 18 kare alındı. Her karenin JPEG’i, TV’nin kendisinden iki kez indirilip aynı PaddleOCR işlemine verildi. Bir istekte Node 8.12.0’ın varsayılan HTTPS ayarı, diğerinde kareler arasında açık tutulan tek HTTPS bağlantısı kullanıldı. Sıra her karede değiştirildi. İlk iki ısınma karesi çıkarıldı. Analize giren 16 çiftin her birinde JPEG baytları aynıydı. Kalıcı bağlantı 16 çiftin tamamında aynı soketi yeniden kullandı. [Ham TV ölçümleri](../output/hdmi-capture/http-keepalive/result-1795552597572.json)

| TV’de JPEG indirme isteğinden itibaren | Varsayılan bağlantı, ortalama | Kalıcı bağlantı, ortalama | Kare başına medyan kazanç |
| --- | ---: | ---: | ---: |
| JPEG bellekte hazır | 55,0 ms | 11,1 ms | 41,0 ms |
| OCR başlıyor | 75,7 ms | 31,1 ms | 42,0 ms |
| OCR sonucu hazır | 284,3 ms | 233,2 ms | 43,0 ms |

Kalıcı bağlantıyla OCR 16 karenin tamamında daha erken başladı. Sonuç 13 karede daha erken hazırdı. Banttaki metin bu sahnede boştu ve çeviri çalıştırılmadı. Her çiftte aynı yakalanmış kare kullanıldığı için tablodaki süreler tam ekran yakalama süresinden sonra başlıyor. [Eşleştirilmiş sonuçlar](../output/hdmi-capture/http-keepalive/summary.json) · [TV’de çalışan deney](../output/hdmi-capture/http-keepalive/tv-worker.js)

### Altyazı bandını JPEG çözücüsünden doğrudan almak

TV’deki `libjpeg-turbo 2.0.0` ile PS5’in altı güncel 960×540 JPEG karesi üzerinde iki yöntem karşılaştırıldı. Bir yöntem tüm kareyi gri tonlara çözüp altyazı bölgesini seçti. Diğeri `jpeg_crop_scanline` ve `jpeg_skip_scanlines` ile (182, 388) konumundaki 596×147 bant için gereken satırları üretti ve sonrasında çözmeyi durdurdu. Her ikisi de OCR’nin kullandığı parlaklık dönüşümünü aynı bölgeye uyguladı. Sıkıştırılmış tam JPEG iki yöntemin de girdisiydi. [TV’de kullanılan karşılaştırma kodu](../output/hdmi-capture/http-keepalive/roi/compare.c#L40)

Her karede iki ısınma çiftinden sonra sekiz ölçüm çifti alındı. Toplam 48 çiftte tam çözme ve bandı hazırlama ortalama **9,00 ms**, doğrudan bandı hazırlama **4,85 ms** sürdü. Eşleştirilmiş farkın ortalaması **4,15 ms**, medyanı **3,85 ms** idi. Altı karenin tamamında bandın 87.612 parlaklık değeri birebir eşleşti. Bu süreler JPEG’i çözmeyi ve bandı hazırlamayı kapsıyor. Kalıcı HTTPS bağlantısı ve bant çözücüsü birlikte tek bir uçtan uca OCR turunda ölçülmedi. Canlı altyazı her iki deneyden sonra da okuma durumundaydı. [TV’deki altı kare ve 48 karşılaştırma](../output/hdmi-capture/http-keepalive/roi/live-1795552786032.json)

### Aynı oyun repliğinde İngilizceden Türkçeye gecikme

İki yol aynı yedi saniyelik PS5 oyun kaydı, 960×540 görüntü, 596×147 altyazı bandı, PaddleOCR ve TV’deki Türkçe paketiyle çalıştırıldı. Kayıtta “Staff Member: See? It-it doesn't add up.” repliği ilk kez 3,200 saniyede görünüyor. Türkçe hedef “Gördünüz mü? H-hesap tutmuyor.” idi. Hedef yalnızca ekrana gelen çeviriyi denetlemek için kullanıldı; çeviriyi İngilizce piksellerden çalışan OCR ve paketin eşleştiricisi üretti. Türkçe yazı, kaynak yazıyı örtmemesi için test ekranının üstünde çizildi. Yakalama istekleri her iki yol için de saniyede bir planlandı. [Klibin doğrulanmış kare sınırları](../output/hdmi-capture/combined-onset/display/metadata.json) · [TV’deki çeviri ve OCR deneyi](../output/hdmi-capture/combined-onset/tv-worker.js)

İlk testte video oynatıcısının bildirdiği konum yaklaşık 200 ms’lik adımlarla değişti. Eski ve yeni yol altışar tekrarda doğru repliği gösterdi. Video saatinin çözünürlüğü, yalnızca bu seriden kare hassasiyetinde bir görünme zamanı çıkarmayı engelliyor. [Video oynatıcısıyla ilk seri](../output/hdmi-capture/combined-onset/display-result-1795554041620.json)

Son karşılaştırmada aynı kayıt 20 kare/sn hızla TV uygulamasında oynatıldı. İngilizce yazının henüz bulunmadığı 63. kare ile ilk kez göründüğü 64. kare ardışık çizildi. Kaynak karenin çizimi ve doğru Türkçe metnin ilk çizim fırsatı aynı sayfada `performance.now()` ile zamanlandı. Altı karşılaştırma çiftinde çalıştırma sırası dönüşümlüydü. Her çiftin iki oynatımında da İngilizce replik aynı planlanmış yakalama isteğinde okundu. [Kare dizisinin doğrulaması](../output/hdmi-capture/combined-onset/artifacts/onset/synced-metadata.json) · [12 oynatımın ham kaydı](../output/hdmi-capture/combined-onset/display-result-1795554290662.json)

| İngilizce repliğin çiziminden Türkçenin ilk çizim fırsatına | Ortalama |
| --- | ---: |
| Varsayılan HTTPS bağlantısı ve tam JPEG çözme | 1.587 ms |
| Kalıcı HTTPS bağlantısı ve yalnızca altyazı bandını çözme | 1.478 ms |

**Eşleştirilmiş kazanç medyanı 76 ms, ortalaması 109 ms** oldu. Yeni yol altı çiftin beşinde daha hızlıydı. Bir çiftte 36 ms geç, en büyük farkta 298 ms erken sonuç verdi. Test tek repliği, yerel çeviri paketini ve bir saniyelik örnekleme aralığını kapsıyor. Ölçülen bitiş TV uygulamasındaki çizim fırsatıdır. Fiziksel panel bir kamerayla zamanlanmadı. Geçici uygulama kaldırıldı ve kurulu altyazı uygulamasının PS5’i yeniden okuduğu doğrulandı. [Eşleştirilmiş süreler](../output/hdmi-capture/combined-onset/display-result-1795554290662.analysis.json) · [Son TV durumu](../output/hdmi-capture/combined-onset/restored-status.json)

Kullanıcının ayrıca canlı PS5 ekranında gösterdiği telefon mesajı karesinde iki yol da aynı Türkçe metni okudu. Bu karede İngilizce başlangıcı veya yeni Türkçe çevirinin çizim zamanı bulunmadığı için gecikme hesabında kullanılmadı. [Canlı yazı denemesi](../output/hdmi-capture/combined-onset/user-line-result.json)

### Kalıcı HDMI seçeneği için uygulama izinleri

Önceki süre deneyinde geliştirici bilgisayarı TV’ye ayrı bir kumanda bağlantısıyla `tv/executeOneShot` isteği gönderiyordu. TV içindeki deneme kodu, dönen HTTPS adresinden JPEG’i indirip çözüyor ve OCR’ye veriyordu. Kurulu uygulama tek başına çalışacaksa ekran görüntüsü isteği kendi izinleriyle de başarılı olmalı. [Deneyde ekran görüntüsünü isteyen kod](../output/hdmi-capture/combined-onset/run-display.cjs)

OLED55CX6LA’da, PS5 HDMI 3’e bağlıyken, normal Developer Mode uygulamasının `com.webos.service.apiadapter/tv/executeOneShot` çağrısı `Not permitted to send to com.webos.service.apiadapter.` yanıtıyla reddedildi. Normal geliştirici oturumunun aynı çağrısı da reddedildi. Daha önce uygulamanın kendi servisinde `createHandle` izni ve uygulama imzası içermeyen ayrı kumanda kaydında ekran görüntüsü izni reddedilmişti. Bu sonuçlara göre uygulamanın kendi başına kullanabileceği bir HDMI ekran görüntüsü kaynağı doğrulanamadı. [TV’deki izin denemesi](../output/hdmi-capture/app-source-check/result.json) · [Kurulu servisin çağrısı](../output/hdmi-capture/named-shm-tv/package-live-result.json#L12) · [İmzasız eşleştirme sonucu](../output/hdmi-capture/2026-11-21T12-21-56-021Z/results.json#L194)

HDMI videosu tarayıcıda 1920×1080 ve oynatılıyor durumuna ulaştığında üç ayrı `canvas.drawImage` okuması yapıldı. Her okumada 160×90 pikselin tamamı şeffaf geldi. Geçici uygulama kaldırıldı ve kurulu altyazı uygulaması yeniden HDMI 3’te okuma durumunda görüldü. Yalnızca `CONTROL_DISPLAY` isteyen yeni kumanda eşleştirmesi, kalıcı bir cihaz yetkisi oluşturabileceği için otomatik onayda durdu. Bu eşleştirme çalıştırılmadı. [Tarayıcı piksel testi](../output/hdmi-capture/app-source-check/result.json) · [Geri yükleme sonrası durum](../output/hdmi-capture/combined-onset/restored-status.json)

### Uygulamadaki HDMI seçeneğinin canlı PS5 denemesi

25 Kasım’da kullanıcı onayından sonra yalnızca `CONTROL_DISPLAY` isteyen imzasız kumanda eşleştirmesi tamamlandı. TV'nin verdiği kayıtla `tv/executeOneShot` bir görüntü adresi döndürdü. Uygulamanın 1.0.41 sürümüne eklenen **HDMI (deneysel)** seçeneği kendi yerel kumanda oturumunu açıyor ve eşleştirme anahtarını TV’de saklıyor. Tam 960×540 JPEG’i TV içindeki kalıcı HTTPS bağlantısından alıyor. OCR motoru seçili altyazı ve görev bölgelerini kapsayan bandı çözüyor. [Eşleştirme sonucu](../output/hdmi-capture/app-source-check/unsigned-result.json) · [Uygulama içi yakalama](../tv-app/service/hdmi.js)

Canlı PS5 oturumunda 159 kare alındığında 130 OCR okuması, 21 kullanılabilir metin okuması ve bir Türkçe paket eşleşmesi ile gösterim doğrulandı. Daha sonraki tanılama Lucia’nın İngilizce telefon mesajının %99 OCR güveniyle okunduğunu ve üç Türkçe paket eşleşmesinin altyazı akışına gönderildiğini gösterdi. Son kaydedilen karede bandı hazırlama süresi 4 ms idi. Bu oturumda İngilizceden Türkçeye ekran gecikmesi yeniden zamanlanmadı. [Canlı oyun sayaçları](../output/production-hdmi/live-game.json)

25 Kasım’daki ayrı ölçümde, kullanıcı oynarken açık 1.0.41 uygulaması iki dakika boyunca izlendi. HDMI yolunda 312 kare alındı, 252 OCR güncellemesi ve dokuz Türkçe altyazı olayı kaydedildi. Ölçüme giren 130 model çalıştırmasında, indirilmiş JPEG’in native motora girişinden OCR sonucuna kadar medyan **1.343 ms**, 90. yüzdelik **1.673 ms** oldu. OCR çalıştırmasının medyanı **571 ms**, motor girişinden OCR başlangıcına kadar geçen sürenin medyanı **750 ms** idi. İkinci süre çözmeyi ve kuyruk beklemesini kapsıyor. Ayrı JPEG bant çözme ölçümlerinin medyanı **6 ms**. Tanılama her okumada o anda görünen en son sonucu örnekledi. Kaynak altyazısının ilk görünme anı, ekran görüntüsü isteği, aktarma ve çevirinin tamamı bu süreye dahil değildi. [Canlı oyun gecikme özeti](../output/production-hdmi/timing-1795556356334.summary.json)

### captureservice, libvtcapture ve sürücü sonucu

- Luna `setProperties` yolunda method, width, height ve format; `setOptions` tarafında JPEG kalitesi gibi ayarlar var.
- İncelenen `captureservice` içindeki `setClipRegions`, desteklenmediğini loglayıp yine `true` döndürüyor. Başarı cevabı uygulanmış kırpma kanıtı değil.
- `libvtcapture` içindeki `dumpRegion`, sürücüye taşınıyor; ancak incelenen `_set_vtg_info` yolu bunu çıktı dikdörtgenine (`wout`) yazıyor ve crop x/y değerlerini sıfır bırakıyor.
- Alt katmanda gerçek giriş crop alanını ayarlayan yapı mevcut. Mevcut izinlerle kullanılabilir, doğrulanmış bir public Luna parametresi bulunmadı.

Sonuç: `width/height` küçültmek çıktı ölçekleme ve veri maliyetini azaltabiliyor. `dumpRegion` adı tek başına gerçek kaynak kırpması anlamına gelmiyor.

Kanıt: [captureservice incelemesi](../output/hdmi-capture/firmware-analysis/dvb/report.json), [libvtcapture incelemesi](../output/hdmi-capture/firmware-analysis/dvb/libvtcapture-report.json), [dumpRegion sürücü incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/dump-region-report.json).

### Rootsuz yakalama için modele özgü servisler

OLED55CX6LA’nın 04.64.00 DVB firmware’inde, oyun TV’de tam ekran kalırken geliştirici uygulamasına ilk yakalamadan itibaren yalnızca seçilen HDMI dikdörtgenini veren bir servis bulunamadı. İnceleme, firmware’in kök dosya sistemindeki 116 Luna API tanım dosyasını ve aday servislerin uygulamalarını kapsıyor. Bu sürümde donanımın desteklediği kaynak kırpmasını yazılımdan istemek için gerekli bağlantı, incelenen arayüzlerde eksik. LG de tüketici webOS TV uygulamaları için yayımladığı katalogda bir HDMI ekran yakalama API’si listelemiyor. [Firmware servis taraması](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-service-catalog/alternate-services.json) · [LG’nin Luna API kataloğu](https://webostv.developer.lge.com/develop/references/luna-service-introduction)

| Firmware’deki aday | Bölge isteğine ne oluyor? |
| --- | --- |
| `com.webos.service.capture` | `executeOneShot` kaynak konumu okumuyor. Ayrı oturum açılınca `setClipRegions` koordinatları işlemeden başarı dönüyor. Video yakalama kodu başlangıç konumunu (0, 0) yapıyor. [Yakalama servisi](../output/hdmi-capture/firmware-analysis/dvb/report.json) · [Video yakalama kodu](../output/hdmi-capture/firmware-analysis/dvb/capture-backends.txt#L70) |
| Second Screen üzerinden `tv/executeOneShot` | Uzaktan kumanda servisi sıfırdan sabit bir 960×540 JPEG isteği oluşturup aynı yakalama servisine gönderiyor. İstemcinin kaynak koordinatlarını aktarmıyor. [Kurulu servis kodu](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-service-catalog/alternate-services.json#L306) |
| `videooutput/display/setDisplayWindow` | Gerçek bir `sourceInput` kabul ediyor. LG’nin firmware ile gönderdiği HDMI testinde bu alan, `displayOutput` ile birlikte ekrandaki video penceresine uygulanıyor. Metot görüntü veya ayrı bir yakalama tamponu vermiyor. [Paket içindeki HDMI testi](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/display-and-gateway.json) |
| `surfacemanager/captureCompositorOutput` ve `media/takeSnapshot` | İlki uygulama kimliğiyle bir grafik yüzeyi seçebiliyor. İkincisi bir medya oturumu ve çıktı boyutu kabul ediyor. İkisinin de uygulamasında canlı görüntüden okunacak kaynak dikdörtgeni için parametre yok. [QML ve medya servisi incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/surface-media-snapshot-api.json) |
| `image/cropMultiple` | `offsetX`, `offsetY`, `cropW` ve `cropH` uygulanıyor. Servis bunun için `src` ile verilmiş bir resim dosyasını açıyor. HDMI ekran görüntüsünü önce üretmek gerekiyor. [Şema ve görüntü işleme kodu](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-service-catalog/alternate-services.json) |

Pikselleri başka bir servisten okuma ihtimali de incelendi. HDMI için kurulu LivePlus uygulaması `setVideoPig` koordinatlarını kapanırken videoyu yeniden tam ekran göstermek için kullanıyor. `getTestPatternColor` seçili test deseninin rengini bildiriyor. `photorenderer/capturePhoto` ise fotoğraf oynatıcısındaki görüntüyü işliyor. TV’nin kendi altyazı menüsünün okuduğu `isClosedCaptionExist` alanı, yayın altyazısının varlığını bildiriyor. Bu arayüzlerde PS5 oyununun çizdiği yazıları veya seçilen HDMI piksellerini uygulamaya veren bir işlem bulunamadı. [Firmware’deki uygulama kodları ve servis alanları](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/pixel-and-caption-services.json)

Önceki rootsuz TV denemesinde hem 1080p hem 4K koordinatlarıyla istenen 596×147 çıktıda üst köşedeki logo ve alt kısımdaki görüntü birlikte kaldı. Kaynak YouTube’du. Altyazı bölgesiyle piksel piksel eşleşen sonuç, 960×540 tam görüntü alındıktan sonra yapılan kırpmaydı. Bu servis incelemesi çevrimdışı yapıldı. PS5 üzerinde yeni bir canlı test yapılmadı. [TV denemesi](../output/hdmi-capture/crop-schema/report.json) · [Piksel karşılaştırması](../output/hdmi-capture/crop-schema/pixel-validation.json)

### Root ile ilk kareden itibaren yalnızca altyazı bandını yakalamak

24 Kasım 2026 tarihli bu ek inceleme OLED55CX6LA, O20_DVB ve 04.64.00 sürümüne özgüdür. Firmware çevrimdışı incelendi. Aranan davranış, PS5 oyunu panelde tam ekran görünürken yakalama donanımının ilk kareden başlayarak yalnızca seçilen kaynak dikdörtgenini ayrı bir tampona yazmasıdır.

- **Mevcut sürücü ve PicCap.** Bu firmware’in `video60` sürücüsünde standart V4L2 kaynak kırpma ve alan seçme çağrıları kayıtlı değil. VTG yolu giriş konumunu sıfıra, giriş boyutunu panel boyutuna ayarlıyor. İstemcinin dikdörtgeni çıktı penceresine gidiyor. Diğer yakalama noktası olan VTV dalında düzlem ayarı yalnızca genişlik ve yüksekliği alıyor. PicCap’in kullandığı `libvtcapture` arka ucu da başlangıcı (0,0) yapıyor. Root erişimi bu ayarların anlamını değiştirmiyor. [Sürücüdeki çağrılar ve bölge eşlemesi](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/v4l2_vt.c#L1296) · [Birebir firmware karşılaştırması](../output/hdmi-capture/firmware-analysis/dvb/driver/dump-region-report.json) · [PicCap’in kullandığı arka uç](https://github.com/webosbrew/hyperion-webos/blob/00c932f092084b234b3f619b060a98fa134c12bd/unicapture/backends/libvtcapture.cpp#L60-L78)
- **VTV giriş konumu.** Önceki incelemede aday görünen `HAL_VTV_SetInputPosition` için komutun alıcı tarafı da kontrol edildi. LG sürücüsü dikdörtgeni MCU0’a `DE_IPC_SET_VTV_POSITION` (0x6c) olarak iletiyor. Bu firmware’in MCU0 komut dağıtıcısında 0x6c, `0x502901c8` dallanmasından `0x502904f6` adresindeki geçersiz komut yoluna gidiyor. Burada tanılama açıksa `Invalid DE IPC` kaydı üretilebiliyor ve çağrı sıfır dönebiliyor. Bu yol koordinatları uygulamıyor. [LG komut tanımı](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/mcu/de_ipc_def.h#L221) · [Sürücüdeki gönderim](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/de_io.c#L3366) · [İncelenen MCU0 görüntüsü](../output/hdmi-capture/firmware-analysis/dvb/driver/de-fw-0.bin)

#### IPP3 ile yakalama öncesi kırpma

Bu modelin MCU0 firmware’inde VTG yakalama isteği iki ayrı dikdörtgen taşıyor. Birincisi kaynak görüntüden okunacak bölgeyi, ikincisi üretilecek görüntünün boyutunu belirliyor. `PQE_TASK_Ipp3Manager` etkin giriş konumunu ve boyutunu IPP3 donanımının kırpma yazmaçlarına iletebiliyor. O20 kaynak başlığında bunlar `ipp_crop_offset` ve `ipp_crop_active` olarak geçiyor. Aynı yönetici yakalama tamponunu ayıran `PQE_FBUF_AllocVtg` işlevine **çıktının** genişlik ve yüksekliğini veriyor. Böylece bu işlem hattında bant seçimi yakalama tamponundan önce yapılabiliyor. [04.64.00 makine kodundan ilgili kesitler](../output/hdmi-capture/firmware-analysis/dvb/driver/ipp3-roi/firmware-evidence.json) · [LG O20 yazmaç tanımları](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/chip/o20/de/de_ipp_reg_o20a0.h#L203)

Gerçek MCU0 geometri kodu PC’de 14 sentetik senaryoda yürütüldü. Aşağıdaki karşılaştırmada kaynak 960×540, port alanı HDMI, istenen çıktı 596×147 idi. İstek önce projenin altyazı konumunda (182, 388), sonra aynı boyutla (50, 60) konumunda denendi. MDF, MVT ve CVI, firmware’in HDMI portundan bağımsız seçtiği iç görüntü yollarının adlarıdır.

| İç görüntü yolu ve modu | IPP3’ün seçtiği giriş | Yakalama çıktısı için hesaplanan boyut |
| --- | --- | --- |
| MDF, tek pencere (`NONE`) | Her iki istekte de seçilen konumdaki 596×147 bölge | 596×147 |
| CVI, tek pencere | Her iki istekte de (0, 0) konumundan tam 960×540 | 596×147 |
| MDF, resim içinde resim (`PIP`) | Her iki istekte de (0, 0) konumundan tam 960×540 | 596×147 |

MVT tek pencere ve MDF `OCCUPIED` senaryolarında da giriş konumu korundu. Tüm senaryolar ikinci bir işlemci yazmacı başlangıç durumuyla tekrarlandı ve aynı sonuçlar alındı. Yalnızca çıktı boyutunu ölçmek, altyazı bandının gerçekten seçildiğini göstermeye yetmiyor. [Geometri sonuçları](../output/hdmi-capture/firmware-analysis/dvb/driver/ipp3-roi/geometry_results.json) · [Çevrimdışı test betiği](../output/hdmi-capture/firmware-analysis/dvb/driver/ipp3-roi/geometry_probe.py)

**İlk kare için sürücü koşulu.** Mevcut sürücü oturumu açarken VTG’yi 960×540 çıktı ve üç tamponla etkinleştiriyor. İlk bellek yazmasının boyutu TV’de ölçülmedi. Aday çözüm, kaynak konumu ile çıktı boyutunu ayrı kabul eden ve ikisini de yakalama başlamadan ayarlayan bir sürücü. Model üzerinde uçtan uca doğrulama için PS5 tam ekran kalırken ilk yakalama tamponunun bant boyutunda olduğu ve konumu değiştirince yakalanan piksellerin de değiştiği görülmeli. Çevrimdışı test fiziksel HDMI yönlendirmesini, piksel içeriğini veya gecikmeyi ölçmüyor. [Sürücünün başlangıç ayarları](../output/hdmi-capture/firmware-analysis/dvb/driver/hma-vtm-start/report.json)

#### IPP3’ten geliştirici servisine doğru izlenen koordinatlar

IPP3 yöneticisinin kullandığı giriş dikdörtgeni (`ippIn`), uygun görüntü yolunda MCU0’ın VTG kaydındaki `crop` alanından geliyor. Bu kaydı normal yakalama sırasında Linux sürücüsündeki `_set_vtg_info` dolduruyor. 04.64.00 kernelindeki yükleme ve yazma komutları iki farklı kaynak konumu için çevrimdışı değerlendirildi. 960×540 panel bilgisiyle (182, 388) ve (50, 60) konumlarında 596×147 istendiğinde iki durumda da `crop` başlangıcı (0, 0), boyutu 960×540 kaldı. İstenen konum ve bant boyutu yalnızca çıktı dikdörtgeni `wout` içine yazıldı. Bu sayılar sürücünün yazdığı alanları gösteriyor. [Dört sentetik girdinin sonuçları](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/ordinary-capture-backtrace.json) · [MCU0 tarafındaki alanlar](../output/hdmi-capture/firmware-analysis/dvb/driver/ipp3-roi/firmware-evidence.json)

04.64.00 kernelinde `video60` için kayıtlı 20 V4L2 işlevinin tamamı LG referans kaynağıyla eşleşti. Tabloda standart kaynak kırpma veya alan seçme işlevi yok. Düzlem, kare hızı ve dondurma ayarları aynı `_set_vtg_info` işlevine ulaşıyor. Çok düzlemli biçim ayarı yalnızca en ve boy alıp konumu sıfırlıyor. Uygulama tarafında ise LG’nin `setClipRegions` metodu koordinatları okumuyor. Projemizin `setRegion` metodu koordinatları OCR işçisine iletiyor. Bu iki uç arasında geliştirici servisinin çağırabildiği ve istenen konumu `crop` alanına taşıyan bir bağlantı bulunamadı. [LG sürücü kaynağı](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/v4l2_vt.c#L1111) · [LG yakalama servisinin incelemesi](../output/hdmi-capture/firmware-analysis/dvb/report.json) · [Projedeki setRegion](../tv-app/service/service.js#L253)

#### video60 dışındaki koordinat yazımları

| Aday | 04.64.00 üzerinde doğrulanan hedef |
| --- | --- |
| Eski VTM yakalama yolu | `de_kwrap_cmdvtm` içinde çağıranın verdiği dört dikdörtgen bileşenini kopyalayan makine komutları bulundu. Hedef 128 baytlık eski VTM kaydının `crop_size` alanı. IPP3’ün modern VTG yakalama kaydı 152 bayt ve incelenen yolda eski konumu bu kayda taşıyan bir dönüşüm bulunamadı. [Eski alanın kaynak kodu](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/de_kwrap_cap.c#L612) · [Kernel karşılaştırması](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/other-driver-geometry.json) |
| VSC görüntü penceresi | `vsc_set_win_info` kaynak konumunu seçili video penceresinin `in_win` alanına yazıyor. Üretim kernelindeki çağrılar giriş ve çıkış pencerelerinin ayarına gidiyor. LG’nin kurulu HDMI örneği `MAIN` görüntü penceresini kullanıyor. Bu çağrıda IPP3 yakalaması için bağımsız bir kaynak dikdörtgeni iletildiğine dair kanıt bulunamadı. [VSC kaynak kodu](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/v4l2_vsc_event.c#L360) · [Firmware’deki HDMI örneği](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/display-and-gateway.json) |

LG’nin aynı nesil için yayımladığı sürücü paketinde, taranan 3.183 C/C++ kaynak ve başlık dosyasında adı açıkça yazılan `crop_size.x/y` atamaları yalnızca eski VTM kodunda ve `video60` sürücüsünde bulundu. Ayrıca üretim firmware’inin ana dosya sistemi ve BSP paketindeki 2.223 kullanıcı alanı ELF dosyası, aday bölge ayarlama işlevlerinin adları için tarandı. İncelenen iki giriş-konumu işlevi yalnızca bunları tanımlayan HAL kütüphanelerinde görüldü. İsim taraması kapalı kodun bütün dolaylı kullanımlarını kapsamaz. Bu incelemede modern IPP3 kaynak dikdörtgenini ayarlayan, Developer Mode’dan çağrılabilir ikinci bir yol doğrulanmadı. TV’ye bağlanılmadı. [Taramanın kapsamı ve sonuçları](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/other-driver-geometry.json)

#### PS5 ana pencerede kalırken ikinci VSC penceresinden altyazı yakalama

LG, OLED55CX6LA için Multi-view desteği listeliyor. 04.64.00 paketindeki O20 yapılandırmasında iki HDMI video alıcı kaynağı tanımlı. VSC, fiziksel HDMI portunu pencere başına saklıyor. Bağlanan her pencereye ayrı `sourceInput` ve `displayOutput` verilebiliyor. LiveZoom kodunda da görüntülenen akışı PIP kaynağına ileten bir yol var. Bununla birlikte paketteki HDMI entegrasyon testi, `SUB` bağlantısında donanım katmanından hata alındığını belirterek yalnızca `MAIN` penceresini deniyor. Bu birim üzerinde PS5 tam ekran kalırken aynı fiziksel portun ikinci bir pencereye eşzamanlı bağlandığı doğrulanmadı. [LG model özellikleri](https://www.lg.com/ua/televisions/lg-OLED55CX6LA) · [O20 yapılandırması ve LiveZoom](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/model-pip-config.json) · [Pencere yönlendirmesi](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/dual-hdmi-display-routing.json)

**İkinci pencere çalışsa bile yakalamada eksik kalan adım, yalnızca o pencerenin piksellerini seçmek.** Stok VTG yakalaması başlatılırken sürücü `win_id` alanına sabit `0` yazıyor. LG’nin pencere tanımında bu değer `MAIN`, `SUB` ise `1`. Normal görüntü yakalama servisinin isteğinde bu alanı seçtiren bir parametre yok. Birleşik ekran görüntüsü görünür PIP’yi içerse bile ana oyunu da içerebilir. [Yakalama kaynağının ve pencerenin seçimi](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/subwindow-capture-selector.json) · [LG pencere tanımı](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/include/de_kapi.h#L456)

Uygulama kimliğiyle ekran görüntüsü alma işlevi, uygulamanın Wayland grafik yüzeyini okuyor. HDMI uygulaması video penceresini ayrı yönetiyor. HDMI oturumundaki `windowId` alanı da görüntülemeyi bağlıyor. İncelenen HDMI servisinde `SUB0` çıkışını bir resim veya piksel tamponu olarak teslim eden bir metot bulunamadı. Dolayısıyla ilk yakalamadan yalnızca altyazı bandını veren rootsuz bir yol doğrulanmadı. TV’de pencere düzeni değiştirilmedi ve canlı piksel testi yapılmadı. [Uygulama yüzeyinin yakalanması](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/subwindow-compositor.json) · [HDMI oturumunun arayüzleri](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/pip-hdmi-session.json)

## /dev/video60 erişimi ve servis izinleri

Sorun yalnızca bir yakalama onay penceresi meselesi değil. Jail içindeki aygıtların varlığı, Unix izinleri, servis kimliği ve yaşam döngüsü ayrı engeller.

- Developer Mode uygulama jail'i video0 ve video20 aygıtlarını alıyor; video60 almıyor. İncelenen aygıtlar video60'ın takma adı değil.
- `builtin_native` ve uygun koşullardaki `mvpd` profilleri video60'ı içerebiliyor. Video60'ın gözlenen izinleri root:video, 0660.
- `prisoner` kullanıcısının video grubunda olması, jail'de bulunmayan aygıt yolunu tek başına erişilebilir yapmıyor.
- Sıradan geliştirici uygulamasının bu ayrıcalıklı jail profilini seçebileceği izinli bir API doğrulanmadı. İncelenen `jailer` dosyası da kullanılabilir bir setuid yükseltme yolu değildi.

**Önemli düzeltme:** Bütün doğrudan capture handle çağrılarının reddedildiği söylenemez. Kayıtlı bir deneyde UID 5051 ile `palmbus.Handle('', true)` üzerinden `createHandle`, `setProperties`, `setOutput`, JPEG/BMP `execute` ve `destroyHandle` başarılı oldu. Başka isimli servis/kütüphane kayıt yollarındaki erişim reddiyle bu başarı karıştırılmamalı.

Başarılı `execute` yolu kabaca init → preprocess/oneshot → process → postprocess → finalize → native fd kapatma sırasını izliyor. Luna handle'ının açık kalması, native VTM/video60 oturumunun açık kalması anlamına gelmiyor.

`setOutput` içinde shared-memory adı/boyutu seçenekleri görülmesi de otomatik olarak ham kare fd'si dışa aktarıldığını veya yakalama oturumunun sürekli tutulduğunu kanıtlamıyor.

Kanıt: [Aracı servis/izin incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/broker-access/report.json), [başarılı doğrudan handle kaydı](../output/hdmi-capture/rootless-access/broker-report.json).

## /dev/lg/de0 denemesi, kernel hatası ve io_resume

### Ne oldu?

UID 5051 ile `/dev/lg/de0` salt okunur açılabildi. Ancak ilk 80 baytlık sorgu, `ioctl 0x80506104`, kernel Oops üretti. Bu çağrının doğru adı **`DE_IO_GetCapacity`**; erken aşamadaki getSystemStatus adlandırması düzeltildi.

Kullanıcı bu olay sırasında görüntü ve sesin normal olduğunu bildirdi. Bu gözlem kernel hatasını geçersiz kılmaz. Bu olay ile daha önce HMA ayırma denemesiyle ilişkilendirilen yeniden başlama birbirinden ayrı tutulmalı.

### Firmware ve kaynak kodundan bulunan neden

İncelenen sürücüde global `io_resume` bayrağı açıkken kullanıcıdan/kullanıcıya kopyalama makroları güvenli user-copy yerine doğrudan bellek kopyalama dalına girebiliyor. İlgili çağrının kullanıcı alanı işaretçisi kernel tarafından bu yanlış dalda kullanılıyor.

Kritik bulgu: **`/proc/lg/de/status` okumak bu bayrağı 1 yapıp geri almayan bir yol içeriyor.** Bazı pencere/debug yollarında da ilgili davranış görüldü. Dolayısıyla görünüşte salt okunur bir durum sorgusu yan etkisiz sağlık kontrolü değil.

Proc içindeki çağrılar zaten kernel belleğini belirten `nFlag=1` bilgisiyle çalışıyor; global bayrağın diğer kullanıcı alanı çağrılarını da etkilemesi sorun yaratıyor. Aygıtı yeniden açmak, 64 bit istemci kullanmak veya istek yapısını değiştirerek denemek global durumu çözmüyor.

`LX_DE_DBG_RESUME_TEST` gibi yolun tam suspend/resume çalıştırıp bayrağı yan etki olarak sıfırlaması, güvenli bir sıfırlama API'si sayılmadı ve uygulanmadı. Kalıcı çözüm sürücüde doğru caller-memory ayrımı ve ilgili global kullanımının düzeltilmesini gerektiriyor; böyle bir düzeltme TV'ye uygulanmadı.

Yan etkisiz, rootsuz ve doğrulanmış bir `io_resume` sorgulama/koruma yöntemi bulunmadı. Tek seferlik bir bayrak okuması olsa bile eşzamanlı değişim sorununu çözmez. Hata sonrasında eski ioctl/mmap/capture-enable denemeleri sürdürülmedi; ilgili deneme çalıştırıcısı devre dışı bırakıldı.

Kanıt: [Oturum sırası incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/session-order-report.json), [GCP sözleşmesi](../output/hdmi-capture/firmware-analysis/dvb/driver/gcp-contract/report.json), [rootsuz bellek incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-vtm-memory/report.json). İlk `de0-session/report.json` raporundaki açık neden soruları, sonraki bulgularla birlikte okunmalı.

## GCP isteğinin alanları ve kalan 46 bayt

`LX_DE_GCP_INFO_T` boyutu **320 bayt**; ilgili ioctl `0x41406160`. Çift yönlü kontrol alanı toplam 640 bayt: A2M başlangıcı 0, M2A başlangıcı 320.

| Alan | Ofset / düzen |
| --- | --- |
| `bl_info[3]` | 0x14; her tanımlayıcı 24 bayt |
| `el_info[3]` | 0x5c; her tanımlayıcı 24 bayt |
| `out_info[3]` | 0xa4; her tanımlayıcı 24 bayt |
| BL buffer adresleri, 3 kayıt | 0xec |
| EL buffer adresleri, 3 kayıt | 0x104 |
| OUT buffer adresleri, 3 kayıt | 0x11c |
| `pqe_meta_idx` | 0x134 |
| `frz` / `frz_idx` | 0x138 / 0x13a |
| `reserved[0]` / `reserved[1]` | 0x13c / 0x13e |

Her tanımlayıcıda sampling, bit depth, stride, width, height ve altıncı 32 bit alan olarak **PTS** bulunuyor. Önceden açıklanamayan 46 bayt şöyle tamamlandı:

- 36 bayt: dokuz tanımlayıcının PTS alanları.
- 8 bayt: `out_buf[2]` Y ve C adresleri, 0x12c ve 0x130.
- 2 bayt: 0x13e'deki `reserved[1]`.

Önceki genel input/output yorumları ve 0x114 output başlangıcı doğru son düzen değil. Dönüştürülmüş callback görünümü karışıklık yaratmıştı. LG başlıklarıyla ARM32/ARM64 derleyici ofset kontrolleri yapıldı.

`reserved` adı alanların daima kullanılmadığı anlamına gelmiyor: `reserved[0]` bazı runtime protokol modlarında kullanılıyor. PTS zaman tabanı, rate birimleri ve bütün protokol semantiği hâlâ tam çözülmüş değil. GCP'nin yapısını bilmek, onu VTM crop/oturum kurulumuyla eşitlemiyor; “SetGCP → CmdVTM4 çalışır” sonucu çıkarılmadı.

Kanıt: [GCP sözleşme raporu](../output/hdmi-capture/firmware-analysis/dvb/driver/gcp-contract/report.json).

## Eski VTM ile modern VTM ayrımı

Bu araştırmanın önemli düzeltmelerinden biri, iki farklı sözleşmenin birbirinin yerine kullanılamaması oldu.

| Özellik | Eski host yolu | Modern V4L2 yolu |
| --- | --- | --- |
| Yapı | `LX_DE_VTM_FRAME_INFO_T` | `VTG_INFO_T` |
| Kayıt boyutu | 128 bayt | 152 bayt, 0x98 |
| Kontrol alanı | Dört adet 128 bayt; toplam 512 | A2M/M2A çifti; toplam 304, 0x130 |
| İlgili giriş | Eski KADP / ioctl 0x40806158 | video60 V4L2 sahibi |

Modern yapının önemli ofsetleri: `crop=0x20`, `wout=0x28`, `secure=0x58`, `mute=0x5c`, `stride=0x60`, `sampling=0x64`, `Y[5]=0x68`, `C[5]=0x7c`, `ridx=0x90`, `reserved=0x94`.

Modern V4L2 başlangıç yolu ayrılmış tabanı alıp 304 baytlık iki kaydı kuruyor ve MCU'ya pencere/taban/enable içeren 12 baytlık mesajı, komut **0x4d** üzerinden iletiyor. Tam firmware'deki MCU dispatcher ve 0x98 kayıt düzeniyle karşılaştırıldı.

**Eski yapının crop alanı 0x68'de; modern yapıda aynı ofset Y kare adresleri.** Bu nedenle eski CmdVTM4 düzeni modern kayıt üzerinde tekrar kullanılmamalı. İncelenen eski yolda 128→152 dönüştüren bir köprü bulunmadı; eski host yapısının bilinmesi mevcut MCU ile aktif uyumluluğunu kanıtlamıyor.

Modern başlangıç yolu `io_resume` dalına bağlı görünmüyor; ama gerçek video60 erişimi ve oturum sahibi gerekiyor. HMA tek başına MCU oturumunu başlatmıyor, sahibi kaydetmiyor veya kuyruk/refcount/kilit yaşam döngüsünü kurmuyor. Son gerçek V4L2 sahibi kapanınca IPC temizlenip yakalama devre dışı kalabiliyor.

Kanıt: [Bağımsız VTM oturumu](../output/hdmi-capture/firmware-analysis/dvb/driver/vtm-independent-session/report.json), [HMA ile oturum başlangıcı incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/hma-vtm-start/report.json).

### Eski VTM tek başına altyazı karesi üretebilir mi?

OLED55CX6LA’nın 04.64.00 firmware’inde iki olasılık ayrı ayrı kontrol edildi.

- **Eski VTM oturumu.** Linux tarafı kaynak koordinatlarını 128 baytlık kayda yazabiliyor. Oturumu başlatırken incelenen eski ve güncel sürücüler, görüntü işlemcisinde aynı kare yakalama işleyicisine bildirim gönderiyor. Bu sürümde işleyici 152 baytlık kaydı kullanıyor. Eski kaydı okuyup ayrı bir altyazı karesi üreten ikinci bir yakalama birimi veya bunu Developer Mode servisine teslim eden bir çağrı doğrulanmadı. [Firmware karşılaştırması](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/legacy-frame-feasibility.json)
- **Tek karelik eski yakalama işlevi.** `HAL_VT_LegacyCaptureVideoFrame` işlevinin kaynak görüntüsünü alan dalı, saklanan dikdörtgeni gerçekten kare isteğinin `inWin` alanına kopyalıyor. Çıktı boyutu ayrı iletiliyor. Ancak üretim kernelinde bu isteği karşılayan normal sürücü dalı, dikdörtgeni okumadan, yakalama birimini çağırmadan ve çıktı bilgilerini yazmadan `0` dönüyor. LG’nin aynı nesil sürücü kaynağında bu dal boş ve eski desteğin kaldırıldığı belirtilmiş. Dolayısıyla bu işlev, koordinatlar doğru olsa da yakalamayı başlatmıyor. Sonuç, cihaz üzerinde alınmış kareye değil, ilgili kernel dalının çevrimdışı incelenmesine dayanıyor. [Kernel dalının doğrulaması](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-region-services/legacy-frame-feasibility.json) · [LG’nin kaynak kodundaki karşılığı](../output/hdmi-capture/firmware-analysis/reference/lg-source-extract/kdriver/kdriver/core/de/resource_mgr.c#L1364)

## HMA üzerinden kare belleğine erişim: bulunan aday ve sınırları

İncelenen kernel'de `/dev/hma` üzerinden zaten var olan fiziksel alanı kendi fd'sine bağlayan `HMA_IOCTL_SET_TEST_ADDR` yolu bulundu. İstek 28 bayt; ARM32/ARM64 düzeni aynı. Bu yol yeni kare havuzu ayırmaktan farklı: küçük metadata tahsisi olabilir, ancak hedef olarak mevcut alanı bağlıyor. `test_addr` durumunda release yolu o alanı `hma_free` ile serbest bırakmıyor.

Statik olarak bu giriş `io_resume` dalına bağlı değil. Gözlenen aygıt modu 0666 olsa da bütün runtime izin/LSM koşulları tüketilerek dışlanmadı. **Bu bir statik aday; çalışan HMA → OCR uygulaması değil.**

Çözülmemiş zorunlu konular:

- Geçerli modern VTM oturumunu izinli bir gerçek sahibi açık tutmalı.
- Adres, boyut, stride, biçim ve secure durumu güvenilir ve güncel olmalı.
- HMA bağlamak kareyi sahiplenmiyor, oturumu canlı tutmuyor veya DMA/CPU tutarlılığını garanti etmiyor.
- Ring indeksi kopyalama öncesi/sonrası aynı olsa bile arada dolaşıp aynı değere dönme ihtimali var; bu tek başına yırtılmasız kare kanıtı değil.
- Sahip kapandıktan sonra eski fiziksel adres kullanılmamalı. OCR öncesinde CPU'nun sahip olduğu bir kopya ve bunun geçerliliği gerekiyor.

`/dev/lg/de0` mmap yolu ise yalnızca belirli firmware ortak bellek aralıklarını kapsıyor; genel VTM kare havuzunu okumaya açan yol olarak doğrulanmadı. Bir yapıdaki `mem_fd` alanı da otomatik olarak istemcinin kullanabileceği DMA fd'si değil. V4L2 EXPBUF yolu görülse bile ilgili kuyruğa erişim gerektiriyor.

Son yetkilendirilmiş örnek uygulama deneyinde HMA erişimi, yeni bellek ayırma veya kernel/veri kontrol alanlarına yazma yapılmadı.

Kanıt: [Rootsuz VTM bellek incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/rootless-vtm-memory/report.json).

## Video Capture Example: statik olasılık ve gerçek TV sonucu

### Firmware'de görülen davranış

Uygulama kimliği `com.webos.exampleapp.videocapture`. Firmware'de binary, app bilgisi ve QML parçaları bulundu. `EosItems` VideoCapture → `libvt` → DILE → V4L2 oluşturma zinciri video60'ı açabilecek bir native sahip adayı gösteriyordu. Terminate/context silme yolu aygıtı kapatıyor.

QML/library incelemesinde yalnızca görünmez olmak ile devre dışı bırakılmak farklı:

- `isVisible=false` olan çizim yolunda doğrudan terminate görülmedi.
- `enabled=false` değişimi terminate; tekrar true ise initialize yoluna gidiyor.
- Destructor terminate ediyor. Context ve event loop yaşarsa çizim yapılmadan olayların sürmesi olası.
- Örneğin app bilgisinde native lifecycle sürümü belirtilmemiş; incelenen SAM varsayılanı V1. V1 PauseAsPolicy yolu SIGTERM ve süreli kapatma içeriyor.

Her HDMI geçişinin kesin aynı pause yoluna girdiği kanıtlanmadı. Dolayısıyla “görünmez olunca kesin kapanır” veya “arka planda kesin açık kalır” deneme öncesinde söylenemezdi. QML'deki 800×600 dikdörtgen de yakalamanın gerçek piksel boyutu/ROI'si değil.

Bu örnekte başka uygulamaya fd veya kare ömrü veren bir broker API'si bulunmadı. Kütüphaneyi geliştirici jail'inde çağırmak da eksik video60 erişimini kendiliğinden sağlamıyor.

Kanıt: [Arka plan yaşam döngüsü incelemesi](../output/hdmi-capture/firmware-analysis/dvb/driver/example-background/report.json).

### Video Capture Example başlatma denemesi

Kullanıcı yalnızca örneği normal şekilde açıp HDMI'ye dönünce süreç/aygıtın açık kalmasını kontrol etmeyi yetkilendirdi; HMA kapsam dışıydı.

| Kontrol | Sonuç |
| --- | --- |
| Binary mevcut mu? | Evet |
| Normal SSAP launch | `500 Application error` |
| Doğrudan normal SAM launch | `-101`, `not exist` |
| SAM getAppInfo | `Invalid appId specified OR Unsupported Application Type` |
| SAM/SSAP uygulama listesi | 123 kayıt içinde bu kimlik yok |
| Örnek süreç | Gözlenmedi |
| Deneme sonunda görüntü | PS5, HDMI 3 |

**Sonuç:** Firmware'de binary olması, gerçek TV'de kayıtlı ve başlatılabilir uygulama olması için yeterli değil. Uygulama açılamadığı için arka plan dayanıklılığı ve video60'ı açık tutması ölçülemedi. Bu, “HDMI'ye geçince kapandı” sonucu değildir. Diğer süreçlerin video60 sahipliği hakkında da sonuç çıkarılmadı.

Bu denemede kurulum, rol/izin değişikliği, SAM dışından elle binary başlatma, eski driver ioctl'i, `/proc/lg/de/status` okuma veya HMA işlemi yapılmadı.

Kanıt: [Son canlı denemenin sonucu](../output/hdmi-capture/example-live/result.json).

## Root, PC, iPhone ve harici cihaz seçenekleri

Root, aygıt ve bellek erişimini teknik olarak genişletebilir. Ancak bu sohbetten güvenli ve uyumlu modern VTM oturumu, yırtılmasız kare okuma veya ölçülmüş OCR hızlanması çıktığı söylenemez. Root uygulanmadı ve bu TV/firmware için başarılı bir root işlemi doğrulanmadı. Sayısal bir kazanç tahmini ölçüm olarak sunulmamalı.

Yedek alınması riski azaltabilir; TV her durumda kurtarılabilir demek değildir. Normal firmware yükleme imkânı boot zinciri, cihaz anahtarları, NVRAM veya fiziksel arıza durumlarının tamamını geri getirme garantisi vermez. Bu sohbette tam, geri yüklemesi sınanmış bir kurtarma yedeği oluşturulmadı.

PC ile OCR/video işini dışarı almak TV'nin yükünü azaltabilecek bir mimari seçenek olarak konuşuldu. iPhone 7 Plus da soruldu; ancak bu cihazla aynı koşullarda ölçüm veya TV'ye OCR karesi sağlayan çalışan entegrasyon yapılmadı. Telefonda Remote Play görüntüsü açılması tek başına o karelerin TV OCR'sine aktarılabildiği anlamına gelmiyor.

Harici cihaz konuşmasında kullanıcının tercihi **PC'siz çözüm**, belirtilen bütçe **10.000 TL** idi. Bu notlarda satın alınmış veya doğrulanmış nihai bir cihaz yok. HDMI aracı seçimi ayrıca çözünürlük, HDR, 4K120/VRR, geçiş gecikmesi ve içerik koruması uyumluluğu gerektirir; fiyat/uyumluluk bu sohbetin ölçülmüş sonucu değil.

QEMU'nun kurulmuş olduğu belirtildi; kullanıcı bunun başka iş için olduğunu açıkladı. Araştırmanın tamamlandığına dair bir QEMU sonucu çıkarılmadı.

## Açık kalan sorular ve sonraki karar noktası

1. Modern video60 oturumunu geliştirici uygulaması adına yasal izinleriyle açık tutan gerçek, başlatılabilir bir sistem sahibi var mı? Firmware'deki örneğin varlığı bunu karşılamadı.
2. Böyle bir sahip varsa yaşam döngüsü HDMI görüntüsü ön plandayken sürüyor mu; kare ömrünü güvenli biçimde paylaşan bir API var mı?
3. CPU okunabilir kare için adres/format/tutarlılık ve ring sahipliği nasıl garanti edilecek? Yalnızca HMA map başarısı yeterli değil.
4. Gerçek altyazı üzerinde 333 ms örneklemeyle uçtan uca gecikme, OCR doğruluğu ve uzun süreli yük nasıl? Mevcut kısa testler bunu cevaplamıyor.
5. Tam ekran PS5 görüntüsünde hangi IPP3 giriş yolu etkin ve ilk yakalama tamponuna yalnızca seçilen altyazı bandı yazılıyor mu? [04.64.00 üzerinde doğrulanan geometri](#ipp3-ile-yakalama-öncesi-kırpma)

Mevcut kanıtlara göre kullanılabilir başlangıç noktası Remote Play veya düşük sıklıklı `executeOneShot`. Modern VTM/HMA yolu araştırma aşamasında. Bu belge yeni TV denemesi, root, izin değişikliği veya HMA erişimi için talimat/onay sayılmaz.

## Kaynaklar, yeniden üretilebilirlik ve kayıt konumları

Bu belgedeki deney sayıları projenin yerel kayıtlarından alındı. `output/` altındaki dosyalar yerel/ignore edilmiş araştırma çıktıları olabilir; yalnızca bu Markdown dosyasını klonlamak bütün kanıtları getirmeyebilir. Bağlantılar belgenin `docs/` konumuna göre verilmiştir.

Resmî firmware kaynağı: [LG OLED55CX6LA destek sayfası](https://www.lg.com/uk/support/product-support/cs-OLED55CX6LA.AEK/), [incelenen firmware indirmesi](https://gscs-b2c.lge.com/downloadFile?fileId=FSzoQOT0hGFle8loekdQ). Paket çevrimdışı incelendi; bu araştırma kapsamında TV'ye yüklenmedi.

LG açık kaynak kaynağı: [LG Open Source, OLED55CX araması](https://opensource.lge.com/product/list?ctgr=005&subCtgr=006&keyword=OLED55CX&schType=1). İncelenen paket `webOS 5.0 JO_2.0_221228`, osSeq 511222; listelenen modeller arasında OLED55CXPUA var. Bu, aynı nesil/SoC için kaynak referansı; **04.64.00'ın birebir build kaynağı olduğu iddia edilmiyor**. Sonuçlar tam firmware binary'leriyle çapraz kontrol edildi.

Yerel inceleme kökü: `output/hdmi-capture/firmware-analysis/`. Önemli dosyalar `dvb/captureservice`, `dvb/libvtcapture.so.1.0.0`, `dvb/driver/kernel.Image`, çıkarılan LG `de_kapi.h`, `de_io.c`, `de_proc.c`, `resource_mgr.c`, `v4l2_vt.c`, `de_reg_o20.c` ve `hma_drv.c` kaynakları.

İncelenen binary'leri ayırt etmek için SHA-256:

| Dosya | SHA-256 |
| --- | --- |
| Kernel | `bbfdf09811294676367a9642153830cace3549fe1e906918eab78e3f24ffd328` |
| MCU0 `de-fw-0.bin` | `0670511418656508fe6bf9296191cb63a63ed5d275d15eea19842e9c041b5b75` |
| `libvtcapture.so.1.0.0` | `16d452bd07973616732c99ec692bdb2ea729849b3319ac5ece811dde62b52606` |

Tam firmware ve kernel tersine mühendislik bulguları, farklı bir firmware'e uygulanmadan önce yeniden doğrulanmalı. Bu belgeye ham bellek içeriği, bağlantı sırları veya hesap bilgileri dahil edilmedi.
