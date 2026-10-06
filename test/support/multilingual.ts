import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';

const FONTS = 'C:/Windows/Fonts/';

export interface LanguageSample {
  /** Tesseract code the engine should pick. */
  code: string;
  font: string;
  lines: readonly string[];
}

/**
 * Business sentences per language, rendered with fonts that ship with
 * Windows. Thai is drawn without OpenType shaping (pdf-lib has none), which
 * Tahoma's pre-positioned marks tolerate; scripts that need shaping to be
 * legible at all (Devanagari, Arabic) are not sampled here.
 */
export const SAMPLES: readonly LanguageSample[] = [
  { code: 'deu', font: 'arial.ttf', lines: ['Die Mitarbeiter haben im letzten Quartal sehr gute Ergebnisse erzielt.', 'Der Umsatz ist in allen Regionen gestiegen und die Kosten sind gesunken.', 'Für das nächste Jahr planen wir weitere Investitionen in Österreich.'] },
  { code: 'fra', font: 'arial.ttf', lines: ['Les ventes ont augmenté dans toutes les régions au troisième trimestre.', 'Nous avons réduit les coûts et amélioré la qualité du service.', "Le conseil présentera le budget de l'année prochaine en décembre."] },
  { code: 'spa', font: 'arial.ttf', lines: ['Las ventas aumentaron en todas las regiones durante el tercer trimestre.', 'La empresa redujo los costes y mejoró la atención al cliente.', 'El próximo año abriremos nuevas oficinas en España y México.'] },
  { code: 'pol', font: 'arial.ttf', lines: ['Sprzedaż wzrosła we wszystkich regionach w trzecim kwartale.', 'Firma obniżyła koszty i poprawiła jakość obsługi klientów.', 'W przyszłym roku otworzymy nowe biura w Łodzi i Gdańsku.'] },
  { code: 'ces', font: 'arial.ttf', lines: ['Prodej vzrostl ve všech regionech během třetího čtvrtletí.', 'Společnost snížila náklady a zlepšila kvalitu služeb.', 'Příští rok otevřeme nové pobočky v Brně a Ostravě.'] },
  { code: 'tur', font: 'arial.ttf', lines: ['Satışlar üçüncü çeyrekte tüm bölgelerde arttı.', 'Şirket maliyetleri düşürdü ve hizmet kalitesini iyileştirdi.', "Gelecek yıl İstanbul ve İzmir'de yeni ofisler açacağız."] },
  { code: 'vie', font: 'arial.ttf', lines: ['Doanh thu đã tăng ở tất cả các khu vực trong quý ba.', 'Công ty đã giảm chi phí và nâng cao chất lượng dịch vụ.', 'Năm tới chúng tôi sẽ mở văn phòng mới tại Hà Nội.'] },
  { code: 'ind', font: 'arial.ttf', lines: ['Penjualan meningkat di semua wilayah pada kuartal ketiga.', 'Perusahaan telah menurunkan biaya dan meningkatkan kualitas layanan.', 'Tahun depan kami akan membuka kantor baru di Jakarta dan Surabaya.'] },
  { code: 'rus', font: 'arial.ttf', lines: ['Продажи выросли во всех регионах в третьем квартале.', 'Компания снизила расходы и улучшила качество обслуживания.', 'В следующем году мы откроем новые офисы в Москве.'] },
  { code: 'ukr', font: 'arial.ttf', lines: ['Продажі зросли в усіх регіонах у третьому кварталі.', 'Компанія знизила витрати та покращила якість обслуговування.', 'Наступного року ми відкриємо нові офіси у Києві та Львові.'] },
  { code: 'ell', font: 'arial.ttf', lines: ['Οι πωλήσεις αυξήθηκαν σε όλες τις περιοχές το τρίτο τρίμηνο.', 'Η εταιρεία μείωσε το κόστος και βελτίωσε την ποιότητα.', 'Του χρόνου θα ανοίξουμε νέα γραφεία στην Αθήνα.'] },
  { code: 'chi_sim', font: 'msyh.ttc', lines: ['今年第三季度公司收入大幅增长。', '各个地区的销售都表现良好。', '明年我们将在上海开设新的办公室。'] },
  { code: 'chi_tra', font: 'msjh.ttc', lines: ['今年第三季度公司收入大幅增長。', '各個地區的銷售都表現良好。', '明年我們將在台北開設新的辦公室。'] },
  { code: 'jpn', font: 'YuGothM.ttc', lines: ['今年の第三四半期は売上が大きく伸びました。', 'すべての地域で販売が好調でした。', '来年は東京に新しい事務所を開設します。'] },
  { code: 'kor', font: 'malgun.ttf', lines: ['올해 3분기 매출이 크게 증가했습니다.', '모든 지역에서 판매가 좋았습니다.', '내년에는 서울에 새 사무실을 엽니다.'] },
  { code: 'tha', font: 'tahoma.ttf', lines: ['ยอดขายเพิ่มขึ้นในทุกภูมิภาค', 'บริษัทลดต้นทุนและปรับปรุงคุณภาพบริการ', 'ปีหน้าเราจะเปิดสำนักงานใหม่ที่กรุงเทพ'] },
];

export const fontAvailable = (file: string) => existsSync(FONTS + file);

/** pdf-lib cannot open TrueType collections (.ttc); hand it the first face. */
const collectionAwareFontkit = {
  create(data: Uint8Array) {
    const font = fontkit.create(data as unknown as Buffer) as unknown as { fonts?: unknown[] };
    return font.fonts ? font.fonts[0] : font;
  },
} as unknown as typeof fontkit;

/** One A4 page: the sample's lines, twice over, at 16 pt (enough text for script detection). */
export async function makeLanguagePdf(sample: LanguageSample): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(collectionAwareFontkit);
  const font = await pdf.embedFont(readFileSync(FONTS + sample.font), { subset: true });
  const page = pdf.addPage([595, 842]);
  const lines = [...sample.lines, ...sample.lines];
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 770 - i * 30, size: 16, font }));
  return pdf.save();
}

/** An English page drawn rotated, as if fed into the scanner sideways or upside down. */
export async function makeRotatedPdf(turn: 90 | 180 | 270): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  const lines = [
    'The committee approved the annual budget after a long discussion.',
    'Revenue grew in every region and operating costs fell slightly.',
    'New offices will open in three cities during the coming year.',
    'The board thanks all employees for their work this quarter.',
  ];
  // Rotating text about the page centre; positions chosen so every line stays on the page.
  lines.forEach((line, i) => {
    const off = 40 + i * 24;
    const at =
      turn === 180 ? { x: 545, y: 72 + off } : turn === 90 ? { x: 72 + off, y: 790 } : { x: 520 - off, y: 60 };
    page.drawText(line, { ...at, size: 13, font, rotate: degrees(turn === 90 ? -90 : turn === 270 ? 90 : 180) });
  });
  return pdf.save();
}

/** Characters (letters and digits only) found, as a share of those expected; order ignored. */
export function charRecall(expected: string, actual: string): number {
  const chars = (s: string) => s.normalize('NFC').match(/[\p{L}\p{N}\p{M}]/gu) ?? [];
  const pool = new Map<string, number>();
  for (const c of chars(actual)) pool.set(c, (pool.get(c) ?? 0) + 1);
  const want = chars(expected);
  let hit = 0;
  for (const c of want) {
    const n = pool.get(c) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(c, n - 1);
    }
  }
  return want.length ? hit / want.length : 1;
}
