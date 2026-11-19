# justinterranova.com

Personal site of Justin Terranova, Data and AI Architect for operations-heavy businesses. Plain HTML, CSS and a few lines of JS. No build step, no tracking.

## Pages

| File | What it is |
|------|------------|
| `index.html` | Single-page home: hero with the Monday brief, results, how I work, experience, independent work, skills, contact |
| `resume.html` | Printable resume (Print or save as PDF button; print styles in `styles.css`) |
| `about.html`, `skills.html`, `portfolio.html` | Redirects to the matching home page section, so old links keep working |
| `styles.css` | All styles, light and dark themes, print styles |
| `script.js` | Theme toggle, print button, footer year |

## Design

Warm paper and ink, one vermilion accent. Newsreader for headings and figures, Geist for text, Geist Mono for labels. Dark theme follows the system and can be switched with the header button.

## Local preview

```bash
python -m http.server 8080
```

## Deploy

GitHub Pages from `main`. CNAME: `www.justinterranova.com`.
