# Justin Terranova Portfolio

Personal portfolio site for **Justin Terranova** — a simple static multi-page site (HTML + CSS + a tiny bit of JS for mobile nav).

**Live repo:** [github.com/jterranova2/justinterranova-com](https://github.com/jterranova2/justinterranova-com)

## Pages

| File | Description |
|------|-------------|
| `index.html` | Home — hero, quote, section cards, contact links |
| `about.html` | About Me + contact details |
| `resume.html` | Full work history + education |
| `skills.html` | Skills in two columns |
| `styles.css` | Shared dark professional theme |
| `nav.js` | Mobile nav toggle |
| `assets/` | Images (placeholders used where downloads were blocked) |

## Open locally

No build step required.

**Option A — open the file**

```bash
open index.html
# or double-click index.html in your file manager
```

**Option B — local server** (recommended so paths behave like production)

```bash
cd justinterranova-com
python3 -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080).

## Deploy

### Cloudflare Pages

1. Log in to [Cloudflare Pages](https://pages.cloudflare.com/).
2. **Create a project** → connect the GitHub repo `jterranova2/justinterranova-com`.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Publish directory:** `/` (site root — where `index.html` lives)
4. Save and deploy. Each push to `main` will republish.

### Netlify

1. Log in to [Netlify](https://app.netlify.com/).
2. **Add new site** → Import from Git → select `jterranova2/justinterranova-com`.
3. Build settings:
   - **Build command:** *(leave empty)*
   - **Publish directory:** `.` (site root)
4. Deploy. Subsequent pushes to `main` trigger new deploys.

You can also drag-and-drop the folder onto Netlify’s manual deploy UI.

## Contact

- Email: [jterranova2@gmail.com](mailto:jterranova2@gmail.com)
- Phone: (408) 560-6987
- LinkedIn: [linkedin.com/in/justinterranova](https://www.linkedin.com/in/justinterranova/)
- Twitter: [twitter.com/justinterranova](https://twitter.com/justinterranova/)
