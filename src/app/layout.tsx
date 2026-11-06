import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { messages } from '@/i18n/messages';
import { siteUrl } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  // Makes canonical and Open Graph URLs absolute on the address this deployment actually has.
  metadataBase: new URL(siteUrl()),
  title: { default: messages.meta.title, template: `%s · ${messages.meta.siteName}` },
  description: messages.meta.description,
  applicationName: messages.meta.siteName,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximum-scale and no user-scalable=no: pinch zoom is a WCAG requirement (1.4.4).
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={messages.meta.lang}>
      <body>
        <a href="#main" className="skip-link">
          {messages.a11y.skipToContent}
        </a>
        {children}
      </body>
    </html>
  );
}
