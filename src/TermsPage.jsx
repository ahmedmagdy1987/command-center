import { SiteHeader, SiteFooter } from './SiteChrome';

/**
 * Terms of Service — TEMPLATE CONTENT ONLY. Generic, jurisdiction-neutral placeholder language;
 * it is NOT legal advice and must be reviewed by a qualified professional before real use.
 */
const SECTIONS = [
  { h: '1. Agreement to these terms', b: 'These Terms of Service govern your access to and use of Corlyvo (the "Service"). By creating an account or using the Service, you agree to these terms. If you do not agree, do not use the Service.' },
  { h: '2. Using the Service', b: 'You may use the Service only in compliance with these terms and all applicable laws. We may add, change, or remove features at any time. We may also suspend or stop providing the Service, with or without notice.' },
  { h: '3. Your account', b: 'You are responsible for your account, for keeping your login credentials secure, and for all activity that happens under your account. Notify us promptly of any unauthorized use. You must provide accurate information and keep it up to date.' },
  { h: '4. Acceptable use', b: 'Do not misuse the Service. That includes attempting to access it in unauthorized ways, disrupting its operation, uploading unlawful or infringing content, or using it to harm others. We may remove content or restrict accounts that violate these terms.' },
  { h: '5. Plans and billing', b: 'Some features may be offered as paid plans. Where paid plans are available, pricing and billing terms will be presented before you purchase. Prices shown today are preliminary and subject to change. Taxes may apply depending on your location.' },
  { h: '6. Content and ownership', b: 'You retain ownership of the content you submit to the Service. You grant us the limited rights needed to operate, secure, and improve the Service. The Service itself, including its software and branding, remains the property of its owners and licensors.' },
  { h: '7. Termination', b: 'You may stop using the Service at any time. We may suspend or terminate access if you violate these terms or if we discontinue the Service. On termination, your right to use the Service ends, though some provisions survive by their nature.' },
  { h: '8. Disclaimers', b: 'The Service is provided "as is" and "as available," without warranties of any kind to the extent permitted by law. We do not warrant that the Service will be uninterrupted, error free, or secure.' },
  { h: '9. Limitation of liability', b: 'To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential, or punitive damages, or for any loss of data, revenue, or profits arising from your use of the Service.' },
  { h: '10. Changes to these terms', b: 'We may update these terms from time to time. If we make material changes, we will take reasonable steps to let you know. Your continued use of the Service after changes take effect means you accept the updated terms.' },
  { h: '11. Contact', b: 'Questions about these terms can be sent to the contact address listed in the site footer.' },
];

export default function TermsPage({ session }) {
  return (
    <div data-surface="dark" className="min-h-screen bg-canvas text-primary flex flex-col">
      
      <SiteHeader session={session} />
      <main className="flex-1 w-full max-w-3xl mx-auto px-5 lg:px-8 py-12">
        <h1 className="text-3xl lg:text-4xl font-semibold font-brand tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-faint">Last updated: June 2026</p>
        <div className="mt-8 space-y-7">
          {SECTIONS.map(s => (
            <section key={s.h}>
              <h2 className="text-base font-semibold text-primary">{s.h}</h2>
              <p className="mt-1.5 text-sm text-muted leading-relaxed">{s.b}</p>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
