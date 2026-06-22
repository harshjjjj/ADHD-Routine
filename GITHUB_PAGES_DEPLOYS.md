# Deploying Truce App to GitHub Pages with truceapp.site

Because GitHub requires specific, advanced permissions for third-party apps to modify workflow files (the files inside `.github/workflows/`), we have safely removed the active workflow file so your code can sync immediately to GitHub.

You can set up deployment using either of the two easy methods below:

---

## Method 1: Web-based GitHub Actions (Highly Recommended)
You can create this workflow file directly on GitHub—no local setup or special app permissions required!

1. Go to your repository on **GitHub.com**.
2. Click **Add file** -> **Create new file**.
3. Name the file exactly: `.github/workflows/deploy.yml`
4. Paste the following configuration in the editor:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches:
      - main # change this to master if your default branch is master

permissions:
  contents: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build project
        run: npm run build

      - name: Deploy static assets
        uses: JamesIves/github-pages-deploy-action@v4
        with:
          folder: dist
          branch: gh-pages
```

5. Click **Commit changes...** at the top right to save and run the deploy workflow!

---

## Method 2: Re-authorizing the AI Studio App
If you prefer AI Studio to automatically push the workflow files, you can update your GitHub settings:

1. Go to **GitHub Settings** -> **Applications** -> **Authorized GitHub Apps**.
2. Locate the **Google AI Studio** app.
3. Click **Configure** and ensure the **Workflows** permission is checked/granted.
4. Once granted, you can safely create a `.github/workflows/deploy.yml` file here in AI Studio and push it without any warnings!

---

## Custom Domain Configuration
We have already placed a `CNAME` file pointing to `truceapp.site` inside your production assets. 

After your initial deploy finishes, go to **Settings -> Pages** in your GitHub repository and make sure your **Custom Domain** shows up and **Enforce HTTPS** is checked!
