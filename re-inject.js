require('dotenv').config();
const axios = require('axios');

const GITHUB_PAT = process.env.GITHUB_PAT;
const HEADERS = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};

const DEPLOY_YAML_BLUEPRINT = `
name: Faceplate ChatOps Deploy
on:
  repository_dispatch:
    types: [chatops-deploy]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Patch React Router basename
        env:
          SITE_NAME: \${{ github.event.client_payload.site_name }}
        run: |
          APP_FILE=$(find src -name "App.tsx" -o -name "App.jsx" | head -1)
          if [ -z "$APP_FILE" ]; then
            echo "No App.tsx/jsx found, skipping patch"
            exit 0
          fi
          echo "Found: $APP_FILE"
          # Check if basename is already configured
          if grep -q "basename" "$APP_FILE"; then
            echo "basename already set, checking if VITE_BASE_PATH is used..."
            if grep -q "VITE_BASE_PATH" "$APP_FILE"; then
              echo "Already using VITE_BASE_PATH, no patch needed"
            else
              echo "basename exists but not using env var — leaving as is"
            fi
          else
            echo "Patching BrowserRouter with basename..."
            sed -i 's|<BrowserRouter>|<BrowserRouter basename={import.meta.env.BASE_URL}>|g' "$APP_FILE"
            sed -i 's|<BrowserRouter |<BrowserRouter basename={import.meta.env.BASE_URL} |g' "$APP_FILE"
            echo "Patched $APP_FILE successfully"
            cat "$APP_FILE" | head -30
          fi
      - name: Build and Deploy
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: 'ap-south-1'
          SITE_NAME: \${{ github.event.client_payload.site_name }}
          ENV: \${{ github.event.client_payload.environment }}
          DIST_ID: "E2QOC59EK5LGU4"
          VITE_BASE_PATH: /\${{ github.event.client_payload.site_name }}/
        run: |
          npm install
          npx vite build --base=/\$SITE_NAME/
          aws s3 sync ./dist s3://heet-faceplate-\$ENV/\$SITE_NAME --delete
          aws cloudfront create-invalidation --distribution-id \$DIST_ID --paths "/\$SITE_NAME/*"
          echo "FINAL_URL=http://heet-faceplate-\$ENV.s3-website.ap-south-1.amazonaws.com/\$SITE_NAME/" >> \$GITHUB_ENV
      - name: 🚀 Post Summary
        if: success()
        run: |
          echo "### ✅ [View Live Site](\${{ env.FINAL_URL }})" >> \$GITHUB_STEP_SUMMARY
`;

const OWNER = 'heetp0101';

async function updateWorkflow(repo) {
    const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/.github/workflows/deploy.yml`;

    try {
        // Get existing file to get its SHA
        const { data } = await axios.get(url, { headers: HEADERS });
        const existingContent = Buffer.from(data.content, 'base64').toString('utf8');

        if (existingContent.trim() === DEPLOY_YAML_BLUEPRINT.trim()) {
            console.log(`  ✅ ${repo}: Already up-to-date`);
            return;
        }

        // Update with new content
        await axios.put(url, {
            message: 'chore: update deployment pipeline (fix --base path)',
            content: Buffer.from(DEPLOY_YAML_BLUEPRINT).toString('base64'),
            sha: data.sha,
        }, { headers: HEADERS });

        console.log(`  🔄 ${repo}: Workflow UPDATED!`);
    } catch (e) {
        if (e.response && e.response.status === 404) {
            console.log(`  ⏭️  ${repo}: No workflow file, skipping`);
        } else {
            console.log(`  ❌ ${repo}: Error - ${e.message}`);
        }
    }
}

async function main() {
    console.log('🔍 Fetching all repos...\n');

    const { data: repos } = await axios.get(
        'https://api.github.com/user/repos?type=owner&sort=created&direction=desc&per_page=50',
        { headers: HEADERS }
    );

    const myRepos = repos.filter(r => r.owner.login === OWNER);
    console.log(`Found ${myRepos.length} repos. Checking workflows...\n`);

    for (const repo of myRepos) {
        await updateWorkflow(repo.name);
    }

    console.log('\n✅ Done! All workflows are now up-to-date.');
    console.log('👉 Now go to Open WebUI and run "deploy to dev" again.');
}

main().catch(e => console.error('Fatal error:', e.message));
