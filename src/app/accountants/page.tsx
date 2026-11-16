import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Upload, ScanText, ClipboardCheck, BookOpen, Landmark, FileSpreadsheet, Plug, Scissors, Sparkles, Users, ArrowLeft,
} from 'lucide-react';
import { ACCOUNTANTS_PATH, jsonLd, pageMetadata, PRODUCT, siteBaseUrl } from '@/lib/seo';

// Public product page for accounting offices. Every claim below matches what the app does today:
//   upload checks (src/shared/uploadValidation.ts: PDF/JPG/PNG/WEBP, 20 MB), OCR + AI extraction
//   (src/agents/preprocessor, src/agents/extraction), review & approve (/review; export takes approved
//   invoices only, src/app/api/export), supplier -> account mapping (/mappings), bank reconciliation
//   with the missing-invoices sheet (src/lib/exporters/missingInvoices.ts), export plugins
//   (src/integrations/registry.ts: Move-in, Morning, iCount, SUMIT, Excel, webhook), PDF split
//   (src/lib/invoiceSplit.ts, src/shared/documentSplit.ts), learning from corrections
//   (src/shared/learning.ts) and office members (src/shared/authModel.ts: owner / member).
// No prices, customers or certifications: there are none to state.

const TITLE = 'סריקת חשבוניות לרואי חשבון – קליטה אוטומטית ו-OCR בעברית | חשבוניות Pro';
const DESCRIPTION =
  'חשבוניות Pro קולטת חשבוניות ספקים מסריקה או מקובץ, מזהה את הנתונים ב-OCR בעברית ובבינה מלאכותית, ' +
  'ומעבירה אותם לבדיקה ואישור, להתאמות בנק ולייצוא ל-MOVEIN, מורנינג, iCount ו-SUMIT.';

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: ACCOUNTANTS_PATH,
  siteName: PRODUCT,
});

const FEATURES = [
  {
    icon: Upload,
    title: 'העלאה וסריקה של חשבוניות',
    text: 'גוררים קבצים או מצלמים בטלפון: PDF, JPG, PNG ו-WEBP עד 20MB לקובץ. כל חשבונית נשמרת תחת הלקוח שלה במשרד, וקובץ פגום נדחה מיד עם הסבר בעברית.',
  },
  {
    icon: ScanText,
    title: 'OCR בעברית וחילוץ נתונים בבינה מלאכותית',
    text: 'זיהוי טקסט עברי במסמך, ואחריו חילוץ השדות שהנהלת החשבונות צריכה: שם הספק, עוסק מורשה / ח.פ., מספר חשבונית, תאריך, סכום לפני מע"מ, מע"מ, סה"כ ומספר הקצאה.',
  },
  {
    icon: ClipboardCheck,
    title: 'בדיקה ואישור',
    text: 'מסך מפוצל: המסמך המקורי מצד אחד והשדות שחולצו מצד שני. מתקנים מה שצריך, מאשרים או דוחים. המערכת מתריעה על חשבונית שנראית כפולה, ורק חשבוניות מאושרות יוצאות לייצוא.',
  },
  {
    icon: BookOpen,
    title: 'מיפוי ספקים לכרטיסי חשבון',
    text: 'לכל לקוח טבלת מיפוי משלו: ספק או קטגוריה → כרטיס חשבון בהנהלת החשבונות. אפשר לייבא רשימת ספקים מקובץ אקסל, והמיפוי מוחל על החשבוניות הבאות של אותו ספק.',
  },
  {
    icon: Landmark,
    title: 'התאמות בנק ורשימת חשבוניות חסרות',
    text: 'מייבאים דף חשבון בנק או כרטיס אשראי (CSV, XLS, XLSX), מתאימים חיובים לחשבוניות, ומוציאים גיליון של כל החיובים שאין להם חשבונית — מוכן לשליחה ללקוח.',
  },
  {
    icon: FileSpreadsheet,
    title: 'ייצוא ל-MOVEIN',
    text: 'קובץ קליטה לתוכנת הנהלת החשבונות מהחשבוניות המאושרות, לפי מיפוי הכרטיסים של הלקוח. יש גם ייצוא לקובץ Excel.',
  },
  {
    icon: Plug,
    title: 'חיבור למורנינג, iCount ו-SUMIT',
    text: 'שליחת הוצאות מאושרות ישירות לחשבון של הלקוח במורנינג (חשבונית ירוקה), ב-iCount או ב-SUMIT, עם יומן אינטגרציות שמראה מה נשלח ומה נכשל. לחיבורים אחרים יש Webhook ב-JSON.',
  },
  {
    icon: Scissors,
    title: 'פיצול קובץ PDF עם כמה חשבוניות',
    text: 'לקוח שלח סריקה אחת של עשר חשבוניות? המערכת מזהה את הגבולות בין המסמכים ומפצלת את הקובץ לחשבוניות נפרדות, כל אחת עם בדיקה משלה. כשהזיהוי לא ודאי, היא מציעה פיצול לאישורכם.',
  },
  {
    icon: Sparkles,
    title: 'לומדת מהתיקונים שלכם',
    text: 'כשמתקנים שדה שמופיע במסמך (למשל מספר החשבונית ליד "אסמכתא"), המערכת זוכרת את המיקום אצל אותו ספק ומשתמשת בו בחשבוניות הבאות שלו.',
  },
  {
    icon: Users,
    title: 'משתמשי המשרד והרשאות',
    text: 'בעל המשרד מזמין עובדים באימייל ובוחר תפקיד: בעלים או חבר משרד. הנתונים של כל משרד נפרדים, וכל אחד רואה רק את הלקוחות של המשרד שלו.',
  },
] as const;

const STEPS = [
  { title: 'מעלים', text: 'קבצים או צילומים של חשבוניות ספקים, לכל לקוח בנפרד.' },
  { title: 'המערכת קוראת', text: 'OCR בעברית וחילוץ השדות, כולל מיפוי לכרטיס החשבון.' },
  { title: 'בודקים ומייצאים', text: 'אישור במסך אחד, ואז MOVEIN, מורנינג, iCount או SUMIT.' },
] as const;

const FAQ = [
  {
    q: 'אילו קבצים אפשר להעלות?',
    a: 'קובצי PDF ותמונות JPG, PNG ו-WEBP, עד 20MB לקובץ. קובץ PDF שמכיל כמה חשבוניות מפוצל לחשבוניות נפרדות.',
  },
  {
    q: 'האם ה-OCR מתאים לחשבוניות בעברית?',
    a: 'כן. המערכת נבנתה לחשבוניות ישראליות: היא מזהה טקסט עברי ומחלצת שדות כמו עוסק מורשה / ח.פ., מע"מ ומספר הקצאה.',
  },
  {
    q: 'לאן אפשר לייצא את החשבוניות?',
    a: 'לקובץ MOVEIN או Excel, ובחיבור ישיר למורנינג (חשבונית ירוקה), iCount ו-SUMIT. יש גם Webhook ב-JSON לחיבור למערכות אחרות.',
  },
  {
    q: 'האם חשבונית יוצאת בלי שמישהו בדק אותה?',
    a: 'לא. כל חשבונית עוברת במסך "בדיקה ואישור", ורק חשבוניות שאושרו נשלחות לייצוא.',
  },
  {
    q: 'איך מוצאים חשבוניות שהלקוח לא העביר?',
    a: 'מייבאים את דף הבנק או כרטיס האשראי של הלקוח, והמערכת מתאימה חיובים לחשבוניות. חיובים בלי חשבונית יוצאים לגיליון "חשבוניות חסרות" שאפשר לשלוח ללקוח.',
  },
  {
    q: 'אפשר לעבוד כמה אנשים באותו משרד?',
    a: 'כן. בעל המשרד מזמין עובדים באימייל וקובע אם הם בעלים או חברי משרד.',
  },
] as const;

function StructuredData() {
  const url = `${siteBaseUrl()}${ACCOUNTANTS_PATH}`;
  const software = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: PRODUCT,
    url,
    description: DESCRIPTION,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Accounting',
    operatingSystem: 'Web',
    inLanguage: 'he',
    audience: { '@type': 'BusinessAudience', audienceType: 'משרדי רואי חשבון ומנהלי חשבונות' },
    featureList: FEATURES.map((f) => f.title),
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: 'he',
    mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(software) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faq) }} />
    </>
  );
}

function Hero() {
  return (
    <section className="bg-gradient-to-b from-white to-slate-50 py-14 sm:py-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        <p className="inline-flex items-center bg-blue-100 text-blue-700 px-4 py-1.5 rounded-full text-sm font-medium mb-6">
          {PRODUCT} · למשרדי רואי חשבון ומנהלי חשבונות
        </p>
        <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 leading-tight mb-6">
          סריקת חשבוניות לרואי חשבון
          <span className="block text-blue-600 mt-2 text-2xl sm:text-4xl">קליטה אוטומטית של חשבוניות ספקים, עם OCR בעברית</span>
        </h1>
        <p className="text-lg text-slate-600 mb-10 max-w-2xl mx-auto leading-relaxed">
          מעלים את החשבוניות של הלקוח, והמערכת קוראת אותן, ממפה כל ספק לכרטיס החשבון, ומכינה אותן לבדיקה,
          להתאמת בנק ולייצוא לתוכנת הנהלת החשבונות.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 min-h-[52px] rounded-xl text-lg font-semibold shadow-lg shadow-blue-600/20"
          >
            פתיחת משרד
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 bg-white hover:bg-slate-50 text-slate-700 px-8 min-h-[52px] rounded-xl text-lg font-medium border border-slate-200"
          >
            כניסה למשרד קיים
          </Link>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="py-12 sm:py-16">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <h2 id="how-title" className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-10">
          איך זה עובד
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
              <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white font-bold" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="font-semibold text-slate-900 mb-1">{step.title}</h3>
              <p className="text-sm text-slate-600">{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="py-12 sm:py-16 bg-white border-y border-slate-200 scroll-mt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <h2 id="features-title" className="text-2xl sm:text-3xl font-bold text-slate-900 mb-3">
            מה {PRODUCT} עושה בשביל המשרד
          </h2>
          <p className="text-slate-600">מהחשבונית שהלקוח שלח ועד הרישום בהנהלת החשבונות — במקום אחד.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <article key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-100 text-blue-700">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="font-semibold text-slate-900 mb-2">{title}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">{text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="py-12 sm:py-16 scroll-mt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <h2 id="faq-title" className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-8">
          שאלות נפוצות
        </h2>
        <div className="space-y-3">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="group bg-white rounded-xl border border-slate-200 open:shadow-sm">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 px-5 min-h-[52px] font-semibold text-slate-900">
                <h3 className="text-base">{q}</h3>
                <span className="text-blue-600 transition-transform group-open:rotate-45 text-xl leading-none" aria-hidden="true">+</span>
              </summary>
              <p className="px-5 pb-5 text-slate-600 leading-relaxed">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="py-12 sm:py-16 bg-blue-700 text-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
        <h2 className="text-2xl sm:text-3xl font-bold mb-4">מתחילים לקלוט חשבוניות</h2>
        <p className="text-blue-100 mb-8">פותחים משרד, מוסיפים לקוח ומעלים את החשבוניות הראשונות.</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/signup" className="inline-flex items-center justify-center bg-white text-blue-700 hover:bg-blue-50 px-8 min-h-[52px] rounded-xl text-lg font-semibold">
            פתיחת משרד
          </Link>
          <Link href="/login" className="inline-flex items-center justify-center border border-white/40 hover:bg-white/10 px-8 min-h-[52px] rounded-xl text-lg font-medium">
            כניסה
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function AccountantsPage() {
  return (
    <>
      <StructuredData />
      <Hero />
      <HowItWorks />
      <Features />
      <Faq />
      <FinalCta />
    </>
  );
}
