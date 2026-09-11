import { Camera, FileText, Search, Upload, Scan, Download, Check, Mail, Phone } from 'lucide-react';
import Link from 'next/link';

function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-stone-50 via-blue-50/30 to-stone-50 py-16 sm:py-24">
      {/* Subtle paper texture overlay */}
      <div 
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-1.5 rounded-full text-sm font-medium mb-6">
            <Camera className="w-4 h-4" />
            <span>שירות סריקה מקצועי</span>
          </div>

          {/* Main headline */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-stone-900 leading-tight mb-6">
            סריקת תמונות ומסמכים
            <span className="block text-blue-600 mt-2">בעברית</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-stone-600 mb-10 max-w-2xl mx-auto leading-relaxed">
            הפכו את התמונות הישנות והמסמכים שלכם לקבצים דיגיטליים. 
            סריקה איכותית עם זיהוי טקסט עברי — שומרים על הזיכרונות, מקלים על החיפוש.
          </p>

          {/* CTA */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/order"
              className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl text-lg font-semibold shadow-lg shadow-blue-600/25 hover:shadow-xl hover:shadow-blue-600/30 transition-all"
            >
              <Mail className="w-5 h-5" />
              בקשו הצעת מחיר
            </Link>
            <a
              href="#what-we-scan"
              className="inline-flex items-center justify-center gap-2 bg-white hover:bg-stone-50 text-stone-700 px-8 py-4 rounded-xl text-lg font-medium border border-stone-200 shadow-sm hover:shadow transition-all"
            >
              מה אפשר לסרוק?
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function WhatWeScanSection() {
  const items = [
    {
      icon: Camera,
      title: 'תמונות ואלבומים',
      description: 'תמונות ישנות, אלבומי משפחה, צילומים מודפסים — שומרים על הזיכרונות בפורמט דיגיטלי.',
      color: 'bg-amber-50 text-amber-600 border-amber-200',
    },
    {
      icon: FileText,
      title: 'מסמכים וחשבוניות בעברית',
      description: 'מסמכים, קבלות, חשבוניות, חוזים — סריקה עם זיהוי טקסט עברי מלא.',
      color: 'bg-blue-50 text-blue-600 border-blue-200',
    },
    {
      icon: Search,
      title: 'טקסט סרוק שאפשר לחפש',
      description: 'קבצים עם OCR לעברית — תוכלו לחפש בתוך המסמכים הסרוקים כמו בכל קובץ טקסט.',
      color: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    },
  ];

  return (
    <section id="what-we-scan" className="py-16 sm:py-20 bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-stone-900 mb-4">
            מה אפשר לסרוק?
          </h2>
          <p className="text-stone-600 text-lg max-w-2xl mx-auto">
            כל מה שצריך להפוך לדיגיטלי — תמונות, מסמכים, חשבוניות
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-6">
          {items.map(({ icon: Icon, title, description, color }) => (
            <div
              key={title}
              className="relative bg-white rounded-2xl p-6 border border-stone-200 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className={`w-12 h-12 rounded-xl ${color} border flex items-center justify-center mb-4`}>
                <Icon className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-semibold text-stone-900 mb-2">{title}</h3>
              <p className="text-stone-600 text-sm leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const steps = [
    {
      step: 1,
      icon: Upload,
      title: 'שולחים',
      description: 'מספרים לנו מה יש לכם לסרוק — תמונות, מסמכים, כמות משוערת.',
    },
    {
      step: 2,
      icon: Scan,
      title: 'סורקים',
      description: 'אנחנו סורקים באיכות גבוהה עם זיהוי טקסט עברי (OCR).',
    },
    {
      step: 3,
      icon: Download,
      title: 'מקבלים קבצים',
      description: 'מקבלים את הקבצים הדיגיטליים — מאורגנים, ברורים, ניתנים לחיפוש.',
    },
  ];

  return (
    <section className="py-16 sm:py-20 bg-stone-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-stone-900 mb-4">
            איך זה עובד?
          </h2>
          <p className="text-stone-600 text-lg">
            שלושה צעדים פשוטים
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-8">
          {steps.map(({ step, icon: Icon, title, description }) => (
            <div key={step} className="text-center">
              {/* Step number */}
              <div className="relative inline-flex items-center justify-center mb-6">
                <div className="w-16 h-16 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/25">
                  <Icon className="w-7 h-7" />
                </div>
                <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-stone-900 text-white text-sm font-bold flex items-center justify-center">
                  {step}
                </span>
              </div>
              <h3 className="text-xl font-semibold text-stone-900 mb-2">{title}</h3>
              <p className="text-stone-600 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  const points = [
    {
      icon: Check,
      title: 'עברית אמיתית',
      description: 'לא תרגום אוטומטי — הכל בעברית מקור, מותאם לשוק הישראלי.',
    },
    {
      icon: Search,
      title: 'OCR לעברית',
      description: 'זיהוי תווים אופטי מותאם לעברית — גם כתב יד וגם טקסט מודפס.',
    },
    {
      icon: FileText,
      title: 'לא מעבדים בלי בקשה',
      description: 'החומרים שלכם נשארים שלכם. לא משתמשים בהם לשום דבר אחר.',
    },
  ];

  return (
    <section className="py-16 sm:py-20 bg-white border-t border-stone-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-stone-900 mb-4">
            למה אנחנו?
          </h2>
        </div>

        <div className="grid sm:grid-cols-3 gap-8">
          {points.map(({ icon: Icon, title, description }) => (
            <div key={title} className="flex gap-4">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <Icon className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-stone-900 mb-1">{title}</h3>
                <p className="text-stone-600 text-sm leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="py-16 sm:py-20 bg-gradient-to-br from-blue-600 to-blue-700">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
          מוכנים להתחיל?
        </h2>
        <p className="text-blue-100 text-lg mb-8 max-w-xl mx-auto">
          שלחו לנו פרטים ונחזור אליכם עם הצעת מחיר מותאמת
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/order"
            className="inline-flex items-center justify-center gap-2 bg-white hover:bg-stone-50 text-blue-700 px-8 py-4 rounded-xl text-lg font-semibold shadow-lg hover:shadow-xl transition-all"
          >
            <Mail className="w-5 h-5" />
            בקשו הצעת מחיר
          </Link>
          <a
            href="mailto:contact@nadav-shtibel.com"
            className="inline-flex items-center justify-center gap-2 bg-blue-500/20 hover:bg-blue-500/30 text-white px-8 py-4 rounded-xl text-lg font-medium border border-white/20 transition-all"
          >
            <Phone className="w-5 h-5" />
            contact@nadav-shtibel.com
          </a>
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <WhatWeScanSection />
      <HowItWorksSection />
      <TrustSection />
      <CTASection />
    </>
  );
}
