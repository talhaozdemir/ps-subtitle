"""Verify the merged candidate, then promote the identical bytes for packaging."""
import gzip
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

from build_merged_translation import ROOT, REVIEW


def main():
    candidate = ROOT / 'dist/merged/subtitle.json.gz'
    payload = candidate.read_bytes()
    pack = json.loads(gzip.decompress(payload))
    for name, field in [('final-overrides.json', 'final_overrides_sha256'),
                        ('collision-resolutions.json', 'collision_resolutions_sha256')]:
        path = REVIEW / name
        expected = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        assert pack['merge_info'][field] == expected, f'Rebuild candidate after editing {name}'
    result = subprocess.run(['node', '--test', 'tv-app/tools/test_merged_translation.cjs',
                             'tv-app/tools/test_ocr_rate.cjs', 'tv-app/tools/test_speaker_names.cjs',
                             'tv-app/tools/test_key_dedup.cjs', 'tv-app/tools/test_local_context.cjs',
                             'tv-app/tools/test_multiline.cjs'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                            env=dict(os.environ, MERGED_PACK=str(candidate)))
    (REVIEW / 'integration-tests.txt').write_text(result.stdout + result.stderr, encoding='utf-8')
    print(result.stdout, end='')
    if result.returncode:
        print(result.stderr)
        raise SystemExit(result.returncode)
    for script in ['service.js', 'pack.js', 'matcher.js', 'fuzzy.js', 'translation.js', 'speaker-display.js', 'lookup.js', 'text-key.js', 'local-context.js', 'multiline.js']:
        subprocess.run(['node', '--check', str(ROOT / 'tv-app/service' / script)], check=True)

    summary = json.loads((REVIEW / 'merge-summary.json').read_text(encoding='utf-8'))
    sha = hashlib.sha256(payload).hexdigest()
    assert sha == summary['sha256']
    legacy = json.loads(gzip.decompress((REVIEW / 'legacy-subtitle.json.gz').read_bytes()))
    keys = set(pack['entries']) | set(pack['segments'])
    keys.update(pack['speaker_metadata']['keys'])
    old_keys = set(legacy['entries']) | set(legacy['segments'])
    summary.update(legacy_keys_retained=len(keys & old_keys), legacy_keys_removed=len(old_keys - keys),
                   added_keys=len(keys - old_keys), production_file='dist/subtitle.json.gz',
                   integration_tests_passed=int(re.search(r'# pass (\d+)', result.stdout).group(1)),
                   native_ocr_changed=False, tv_hardware_tested=False,
                   runtime_display='speakerless_default_with_name_toggle', names_and_colours_preserved=True)
    summary['dedup_caption_probes'] = int(re.search(r'dedup_caption_probes=(\d+)', result.stdout).group(1))
    summary['dedup_noisy_probes'] = int(re.search(r'dedup_noisy_probes=(\d+)', result.stdout).group(1))
    summary['lookup_compatibility_preserved'] = True
    summary['local_context_source_replays'] = json.loads(re.search(r'context_source_replays=(\[.*\])', result.stdout).group(1))
    summary['local_context_records'] = sum(len(rows) for rows in pack['local_context']['parts'].values())
    summary['local_context_history_limit'] = 10
    summary['local_context_disabled_regression_captions'] = len(pack['speaker_metadata']['records'])
    decisions = json.loads((REVIEW / 'collision-review-input.json').read_text(encoding='utf-8'))
    summary['global_collision_pairs_reviewed'] = len(decisions)
    summary['repeated_context_groups_reviewed'] = json.loads((REVIEW / 'repeated-context-decisions.json').read_text(encoding='utf-8'))['reviewed_groups']
    summary['repeated_context_occurrences_reviewed'] = json.loads((REVIEW / 'repeated-context-decisions.json').read_text(encoding='utf-8'))['reviewed_occurrences']

    # The staging candidate has passed all consumer checks. Promote those exact
    # bytes; keep the immutable pre-merge source under merge-review/legacy-*.
    target = ROOT / summary['production_file']
    temporary = target.with_suffix('.gz.new')
    temporary.write_bytes(payload)
    os.replace(temporary, target)
    package = ROOT / 'tv-app/tools/package.py'
    source, count = re.subn(r'PACK_SHA256 = "[0-9a-f]{64}"', f'PACK_SHA256 = "{sha}"', package.read_text(encoding='utf-8'))
    assert count == 1
    package.write_text(source, encoding='utf-8')
    assert hashlib.sha256(target.read_bytes()).hexdigest() == sha

    folder = ROOT / 'translations/merged'
    folder.mkdir(exist_ok=True)
    (folder / 'validation.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    selections = json.loads((REVIEW / 'selected-records.json').read_text(encoding='utf-8'))
    readable = []
    for row in selections:
        readable.append(f"{row['ref']} | {row['choice']}\nEN: {row['english']}\nÖNCEKİ: {row['previous']}\nSEÇİLEN: {row['translation']}")
    (folder / 'SECILEN-CEVIRILER.txt').write_text('\n\n'.join(readable) + '\n', encoding='utf-8-sig')
    report = f'''BİRLEŞİK GTA VI TÜRKÇE SÖZLÜK

Kullanılacak tek paket: dist/subtitle.json.gz
Biçim: {pack['format']} / gta-6
SHA-256: {sha}

ORTAK REPLİKLERİN İNCELEMESİ
1–9. bölümde toplam {summary['reviewed_source_records']} kaynak kayıt.
Eski sözlükle ortak {summary['common_caption_records']} kaynak kayıt ve {summary['common_pack_keys']} paket anahtarı.
Farklı EN/yeni/eski karşılıklarından {summary['reviewed_pairs']} benzersiz karşılaştırmanın tamamı üç ajan arasında bölünerek okundu; kararlar eksiksiz ve tekil doğrulandı.
İlk karşılaştırma kararları: {summary['decisions']['old']} eski, {summary['decisions']['new']} yeni.
Normalize edilmiş Türkçesi aynı olan {summary['identical_occurrences']} eşleştirmede yeni kaynak yazımı korundu. Bu grup ayrıca farklı çeviriymiş gibi sayılmadı.
Aynı karşılık çiftinin birden fazla sahnede kullanıldığı {summary['repeated_context_groups_reviewed']} grup / {summary['repeated_context_occurrences_reviewed']} görünüm ayrıca bağlama göre okundu; gerekli görünüm bazlı istisnalar final-overrides.json içinde.
Sözlük genelindeki {summary['global_collision_pairs_reviewed']} kısa/çakışan anahtar iki ajan tarafından bağımsız okundu. İkisi de güvenli bulmadıkça ortak karşılık seçilmedi.

SONUÇ
{summary['final_keys']} fiziksel çeviri anahtarı. {summary['deduplicated_keys']} aynı karşılıklı isimli/isimsiz çiftte çeviri yalnız bir kez saklanır. İsimli okumalar mevcut kaynak/konuşmacı bilgilerinden ortak kayda yönlendirilir; yeni bir alias tablosu pakete eklenmez.
Önceki {summary['effective_keys']} okuma yolunun tamamı çalışır. Eski paketten {summary['legacy_keys_retained']} okuma anahtarı korunuyor; {summary['added_keys']} yeni okuma anahtarı vardır. Bunlar benzersiz replik sayısı değildir.
{summary['equivalent_keys_resolved']} anahtarda farklı ama uyumlu Türkçe karşılıklar ortak gösterimde uzlaştırıldı.
Anlamı/soru biçimi/bağlamı farklı olan {summary['ambiguous_keys_omitted']} anahtar güvenli eşleştirmeden çıkarıldı. Bunların {summary['legacy_keys_removed']} adedi eski pakette de vardı. İlgili kaynak replikler ve isim/renk bilgileri silinmedi; speaker_metadata.records içinde duruyor. API anahtarı varsa mevcut çeviri sistemi bu eşleşmeyen replikler için devreye girebilir.

İSİM VE RENKLER
{summary['speaker_occurrences']} isim/rol görünümünün bütün kaynak renk kayıtları, aynı karedeki iki farklı renkli Polis dahil, aynen korundu. Renkler kişi başına sabit varsayılmadı. Yalnız eski sözlükte olan anahtarlara isim veya renk uydurulmadı.
Varsayılan gösterim isimsizdir. Altyazı görünümü → Konuşmacı isimleri ayarıyla açılır ve kaydedilir. Güvenle belirlenen isimler kaynak renkleriyle gösterilir; isim bilgisi bulunmayan veya konuşmacısı belirsiz kayıtlar isimsiz kalır. Renk ailesi biliniyorsa yaklaşık aile rengi, renk de belirsizse normal yazı rengi kullanılır. Aynı cümleyi söyleyen farklı kişilere Türkçe metinden isim aktarılmaz.

YEREL BAĞLAM
{summary['local_context_records']} kaynak kaydının bölüm/sıra bilgisi local_context alanındadır. Her oyun akışı son 10 farklı okumayı ayrı hafızada tutar. Belirsiz çeviri veya okunamayan isim için en az iki farklı, yüksek güvenli ve doğrudan eşleşmiş önceki replik aynı kaynak sırasını desteklemelidir. Bağlamdan çıkarılan sonuçlar yeni güçlü dayanak yapılmaz.
Güvenilir mevcut isimli eşleşme ve mevcut yaklaşık eşleşme aynen korunur. Diğer belirsiz okumalar, yalnız yakın kaynak penceresinde ve açık aday farkıyla çözülür. Kısa ara replikler eski kayda geri dönmeyi engeller; iki eşit olasılıklı sahne, tekrar eden kısa cevap veya gerileyen OCR parçası zorla seçilmez. Eski bağlam durdurma/yeniden bağlantı/ayar değişiminde, uzun arada ve sıra uyuşmazlığında bırakılır. Önceki konuşmanın adı yeni konuşmaya taşınmaz.
API isteklerinin metni/modeli değiştirilmedi. Yalnız önbellek ve bekleyen iş kimliği bağlama göre ayrılır; aynı kısa cümlenin başka sahnedeki API karşılığı otomatik tekrar kullanılmaz. Yerel bağlam kullanımı için API anahtarı gerekmez. Kaynak sıralaması olmayan eski kayıtlar mevcut eşleştirmeyle çalışmaya devam eder.

OCR VE ÇEVİRİ DOĞRULAMASI
{summary['integration_tests_passed']} test geçti. Testler isim aç/kapat ayarı, kalıcı kayıt, ekran önizlemesi/kaydetme/iptal, aynı replikte konuşmacı değişimi, güvenli renkli çizim, ortak anahtar kapsamı, bütün isim/renkler, seçilmiş çevirilerin gerçek eşleştiricide bulunması, eski anahtar/imza koruması, yeni fuzzy dizini, OCR karakter onarımı, belirsiz kayıtların yanlış geri gelmemesi, eski/bozuk TV önbelleğinden geçiş ve yerel çeviri akışını kapsar.
Tekilleştirme öncesi bağımsız kod/sözlük referansıyla {summary['dedup_caption_probes']} kaynak okuma biçimi ve {summary['dedup_noisy_probes']} hatalı OCR denemesinde tam sonuç (Türkçe, skor, yaklaşık eşleşme durumu, isim ve renkler) aynı kaldı. Önceki {summary['effective_keys']} anahtarın hepsi aynı çeviriye ulaşıyor; fuzzy imzalarının tamamı bayt düzeyinde korundu.
Bağlam kapalı ve yeni sıfırlanmış oturumlarda {summary['local_context_disabled_regression_captions']} kaynak kaydının sonucu önceki bağımsız uygulama koduyla aynı. Kaynak sırasıyla, isimli ve isimleri OCR'de okunmamış iki ayrı tekrar oynatmada bağlamın seçtiği çeviri/isimler kaynak kayıtlarla doğrulandı. Bu deneme kaynak videolara aittir; gerçek TV üzerindeki bütün oynanışların doğruluk ölçümü değildir.
Native OCR motoru, kırpma, model, okuma sıklığı ve API istekleri değiştirilmedi. Çeviri değerleri yine metindir; aynı değerli isimli/isimsiz kayıtlar tek fiziksel girdiyi paylaşır. Eşleştirme davranışını korumak için benzerlik imzaları aynen tutulur.
Tekilleştirilmiş paket biçim 3 kullanır ve güncellenmiş uygulamayla açılır. Güncel uygulama eski biçim-2 paketleri de okur. Eski uygulamalar yeni biçimi sessizce eksik okumak yerine reddedip çalışan eski sözlüklerini korur. Bu paketle birlikte güncel uygulama kodu paketlenmelidir.
Doğrulama yerelde yapıldı; TV'ye kurulum veya gerçek TV üzerinde donanım testi yapılmadı. Yeni IPK üretilmedi.

DÜZENLEME / KAYNAKLAR
translations/merge-review/review-decisions-1.json, -2.json, -3.json: bütün farklı ortak karşılıkların kararları.
translations/merge-review/final-overrides.json: nihai uzlaştırmalar ve bağlam düzeltmeleri.
translations/merge-review/collision-resolutions.json: güvenle birleştirilen eşdeğer karşılıklar.
translations/merge-review/merge-conflicts.json: güvenle tek karşılığa indirilemeyen anahtarlar.
translations/merge-review/legacy-subtitle.json.gz: değiştirilmeyen eski kaynak sözlük.
translations/merged/SECILEN-CEVIRILER.txt: yeni kaynak metne göre farklı seçilen karşılıklar.
tv-app/tools/build_merged_translation.py: yeniden üretim aracı; incelenmiş kaynak değişirse eski kararı uygulamaz.
translations/key-dedup/baseline: tekilleştirme öncesi bağımsız uygulama kodu ve sözlük referansı.
translations/key-dedup/compacted-keys.json: tekilleştirilen kaynak/hedef çiftleri denetim kaydı; uygulamanın paketinde ayrı bir alias tablosu bulunmaz.

Anahtar sayıları benzersiz konuşma veya oyun kapsama oranı değildir; aynı konuşmanın OCR biçimleri ve parçaları ayrı anahtarlar olabilir. Kaynak videolardaki mevcut sansür/eksik parça ve yaklaşık zaman sınırlamaları sürer. Bölüm kaynakları ve renk kanıt dosyaları değiştirilmedi.
'''
    (folder / 'OKU.txt').write_text(report, encoding='utf-8-sig')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
