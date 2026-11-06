import { messages } from '@/i18n/messages';

const copy = messages.home;

export default function HomePage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-16">
      <p className="text-sm font-semibold tracking-wide text-accent uppercase">{copy.eyebrow}</p>
      <h1 className="mt-3 text-4xl leading-tight font-bold text-ink sm:text-5xl">{copy.title}</h1>
      <p className="mt-5 text-lg leading-relaxed text-muted">{copy.lead}</p>

      <section aria-labelledby="checks" className="mt-12">
        <h2 id="checks" className="text-base font-semibold text-ink">
          {copy.checksHeading}
        </h2>
        <ul className="mt-4 grid gap-3">
          {copy.checks.map((check) => (
            <li key={check.name} className="rounded-lg border border-line bg-surface p-4">
              <p className="font-semibold text-ink">{check.name}</p>
              <p className="mt-1 text-muted">{check.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="next" className="mt-12 border-t border-line pt-6">
        <h2 id="next" className="text-base font-semibold text-ink">
          {copy.nextHeading}
        </h2>
        <p className="mt-2 text-muted">{copy.next}</p>
      </section>
    </main>
  );
}
