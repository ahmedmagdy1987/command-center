import { SiteHeader, SiteFooter } from './SiteChrome';

/**
 * Privacy Policy — TEMPLATE CONTENT ONLY. Generic, jurisdiction-neutral placeholder language;
 * it is NOT legal advice and must be reviewed by a qualified professional before real use.
 */
const SECTIONS = [
  { h: 'Overview', b: 'This Privacy Policy explains what information Command Center (the "Service") collects, how it is used, and the choices you have. By using the Service, you agree to the practices described here.' },
  { h: 'Information we collect', b: 'We collect the information you provide directly, such as your name, email address, and the content you create in the Service. We also collect basic technical information, such as device and usage data, that is generated as you use the Service.' },
  { h: 'How we use information', b: 'We use information to provide, secure, and improve the Service, to authenticate accounts, to enable collaboration features, to communicate with you about the Service, and to comply with legal obligations.' },
  { h: 'How we share information', b: 'We do not sell your personal information. We share it only with service providers that help us operate the Service, with other members of your workspace as required for collaboration, or when required by law.' },
  { h: 'Data security', b: 'We use reasonable technical and organizational measures designed to protect your information. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.' },
  { h: 'Data retention', b: 'We retain information for as long as your account is active or as needed to provide the Service, resolve disputes, and meet legal requirements. You may request deletion of your account and associated data.' },
  { h: 'Your rights and choices', b: 'Depending on where you live, you may have rights to access, correct, export, or delete your personal information. You can update much of your information from within the Service, or request help through the contact address in the footer.' },
  { h: 'Cookies and similar technologies', b: 'We use cookies and similar technologies to keep you signed in, remember preferences, and understand how the Service is used. You can control cookies through your browser settings, though some features may not work without them.' },
  { h: 'Changes to this policy', b: 'We may update this policy from time to time. If we make material changes, we will take reasonable steps to notify you. Your continued use of the Service after changes take effect means you accept the updated policy.' },
  { h: 'Contact', b: 'Questions about this policy can be sent to the contact address listed in the site footer.' },
];

export default function PrivacyPage({ session }) {
  return (
    <div data-surface="dark" className="min-h-screen bg-canvas text-white flex flex-col">
      
      <SiteHeader session={session} />
      <main className="flex-1 w-full max-w-3xl mx-auto px-5 lg:px-8 py-12">
        <h1 className="text-3xl lg:text-4xl font-semibold font-display tracking-tight">Privacy Policy</h1>
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
