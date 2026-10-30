import { Shield, Mail } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'פרטיות | סריקה בעברית' },
  description: 'סריקת תמונות ואלבומים, מסמכים וחשבוניות בעברית. זיהוי טקסט עברי (OCR) — קבצים דיגיטליים שאפשר לחפש.',
  keywords: ['סריקה', 'עברית', 'OCR', 'תמונות', 'מסמכים', 'חשבוניות', 'אלבומים', 'דיגיטציה'],
  openGraph: { title: 'סריקה בעברית', description: 'סריקת תמונות ומסמכים בעברית עם זיהוי טקסט', locale: 'he_IL', type: 'website' },
};

export default function PrivacyPage() {
  return (
    <div className="py-12 sm:py-16">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-1.5 rounded-full text-sm font-medium mb-4">
            <Shield className="w-4 h-4" />
            <span>פרטיות</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-stone-900 mb-3">
            מדיניות פרטיות
          </h1>
          <p className="text-stone-600">
            עדכון אחרון: ספטמבר 2026
          </p>
        </div>

        {/* Content */}
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-6 sm:p-8 space-y-8 prose prose-stone max-w-none">
          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">מי אנחנו</h2>
            <p className="text-stone-600 leading-relaxed">
              סריקה בעברית הוא שירות סריקת תמונות ומסמכים בעברית. 
              האתר מופעל על ידי נדב שטיבל. ליצירת קשר: <a href="mailto:contact@nadav-shtibel.com" className="text-blue-600 hover:underline">contact@nadav-shtibel.com</a>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">מידע שאנו אוספים</h2>
            <p className="text-stone-600 leading-relaxed mb-3">
              כאשר אתם פונים אלינו דרך טופס ההזמנה, אנו אוספים:
            </p>
            <ul className="list-disc list-inside text-stone-600 space-y-1">
              <li>שם מלא</li>
              <li>פרטי קשר (טלפון או אימייל)</li>
              <li>פרטים על החומר לסריקה (סוג, כמות)</li>
              <li>הערות שבחרתם לשתף</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">איך אנו משתמשים במידע</h2>
            <p className="text-stone-600 leading-relaxed">
              המידע משמש אותנו אך ורק לצורך מתן הצעת מחיר ותיאום השירות. 
              אנו לא מוכרים, משכירים, או משתפים את המידע שלכם עם צדדים שלישיים לצורכי שיווק.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">החומרים שלכם</h2>
            <p className="text-stone-600 leading-relaxed">
              תמונות ומסמכים שנמסרים לנו לסריקה נשמרים באופן מאובטח למשך תקופת העבודה בלבד. 
              לאחר השלמת הסריקה ומסירת הקבצים, החומרים נמחקים ממערכותינו. 
              אנו לא משתמשים בחומרים שלכם לשום מטרה אחרת מלבד מתן השירות המבוקש.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">אבטחת מידע</h2>
            <p className="text-stone-600 leading-relaxed">
              אנו נוקטים באמצעי אבטחה סבירים כדי להגן על המידע שלכם. 
              הטפסים באתר מועברים בהצפנה. עם זאת, אין שיטה של העברת מידע באינטרנט שהיא מאובטחת ב-100%.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">זכויותיכם</h2>
            <p className="text-stone-600 leading-relaxed">
              אתם יכולים לבקש לראות, לתקן, או למחוק את המידע האישי שלכם בכל עת. 
              פנו אלינו בכתובת <a href="mailto:contact@nadav-shtibel.com" className="text-blue-600 hover:underline">contact@nadav-shtibel.com</a> ונטפל בבקשתכם.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">שינויים במדיניות</h2>
            <p className="text-stone-600 leading-relaxed">
              אנו עשויים לעדכן מדיניות זו מעת לעת. שינויים מהותיים יפורסמו בדף זה.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-stone-900 mb-3">יצירת קשר</h2>
            <p className="text-stone-600 leading-relaxed">
              לשאלות בנוגע לפרטיות, פנו אלינו:
            </p>
            <a
              href="mailto:contact@nadav-shtibel.com"
              className="inline-flex items-center gap-2 mt-3 text-blue-600 hover:text-blue-700 font-medium"
            >
              <Mail className="w-4 h-4" />
              contact@nadav-shtibel.com
            </a>
          </section>
        </div>
      </div>
    </div>
  );
}
