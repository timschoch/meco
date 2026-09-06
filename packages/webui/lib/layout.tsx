/**
 * The one document shape every page shares, and the only stylesheet there is.
 *
 * Dark on light, system fonts, no framework, no client script: the colours are
 * not a Look, and a page that needs a bundle is a page that stops working the
 * day the bundle does.
 */
import type { Child } from "hono/jsx";

const STYLE = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #16181d;
    background: #fbfbfc;
  }
  main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  a { color: #16181d; }
  nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 1.5rem; }
  nav section { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
  nav h2 {
    font-size: .75rem; text-transform: uppercase; letter-spacing: .06em;
    color: #6b7280; margin: 0;
  }
  nav a {
    text-decoration: none; border: 1px solid #d8dade; border-radius: 999px;
    padding: .1rem .6rem; font-size: .8125rem; background: #fff;
  }
  nav a[aria-current="true"] { background: #16181d; color: #fff; border-color: #16181d; }
  .grid {
    display: grid; gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  }
  .card {
    display: block; text-decoration: none; background: #fff;
    border: 1px solid #e6e7ea; border-radius: .5rem; overflow: hidden;
  }
  .card img { display: block; width: 100%; height: auto; background: #eceef1; }
  .card dl { margin: 0; padding: .6rem .75rem; font-size: .8125rem; }
  .card dt { color: #6b7280; }
  .card dd { margin: 0 0 .35rem; }
  table { border-collapse: collapse; width: 100%; font-size: .8125rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e6e7ea; }
  th { color: #6b7280; font-weight: 500; }
  th.number, td.number { text-align: right; font-variant-numeric: tabular-nums; }
  td code { color: #9a2c2c; }
  .empty, .note { color: #6b7280; }
  .older { display: inline-block; margin-top: 1.5rem; }

  h2 { font-size: .9375rem; margin: 2rem 0 .5rem; }
  pre {
    background: #fff; border: 1px solid #e6e7ea; border-radius: .5rem;
    padding: .75rem; overflow-x: auto; font-size: .8125rem; margin: 0;
  }
  .facts { display: grid; grid-template-columns: 7rem 1fr; gap: .15rem 1rem; margin: 0; }
  .facts dt { color: #6b7280; }
  .facts dd { margin: 0; }
  .error {
    background: #fff5f5; border: 1px solid #f0c9c9; border-radius: .5rem;
    padding: .75rem; margin-top: 1.5rem;
  }
  .error p { margin: 0 0 .25rem; }
  .steps { list-style: none; margin: 0; padding: 0; }
  .steps li { display: grid; grid-template-columns: 12rem 1fr 5rem; gap: .75rem; align-items: center; }
  .step-dur { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { display: block; background: #eceef1; border-radius: 999px; height: .5rem; }
  .bar-fill { display: block; background: #16181d; border-radius: 999px; height: 100%; }
  .source { display: block; width: 100%; height: auto; background: #eceef1; border-radius: .5rem; }
  .overlay { position: relative; display: block; max-width: 40rem; }
  .overlay .region, .overlay .window { position: absolute; }
  .overlay .region { border: 2px solid #2563eb; }
  .overlay .region[data-hidden="true"] { border-color: #b91c1c; border-style: dashed; }
  .overlay .window { border: 2px dashed #16181d; box-shadow: 0 0 0 100vmax rgba(0,0,0,.06); }
  .overlay .tag {
    position: absolute; top: 0; left: 0; transform: translateY(-100%);
    background: #16181d; color: #fff; font-size: .6875rem; padding: 0 .3rem;
    white-space: nowrap; border-radius: .2rem;
  }
`;

export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {/*
          CSS is raw text, not markup: a browser does not decode an entity
          inside `<style>`, so an escaped `"` breaks the rule it sits in —
          measured on the preview, where `font: … "Segoe UI"` shipped as
          `&quot;Segoe UI&quot;` and the attribute selector below it with it.
          `STYLE` is a literal in this file and carries nothing a caller wrote,
          which is what makes this safe and keeps it the only such place.
        */}
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

/** What a refusal or an outage looks like. One shape for `400`, `403`, `404`, `503`. */
export function Refusal(props: {
  title: string;
  code: string;
  detail: string;
}) {
  return (
    <Layout title={`meco — ${props.title}`}>
      <h1>{props.title}</h1>
      <p>
        <code>{props.code}</code>
      </p>
      <p class="note">{props.detail}</p>
    </Layout>
  );
}
