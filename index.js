require('dotenv').config(); // Loads keys from your .env file
const express = require('express');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const git = require('simple-git')();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");

const axios = require('axios');
const sodium = require('libsodium-wrappers'); // <-- ADD THIS


// Load the private key you just downloaded
const privateKey = fs.readFileSync("./faceplate-factory.2026-03-18.private-key.pem", "utf8");


// ADD THIS NEW FUNCTION - Encrypts and sets a secret on a repo
async function setRepoSecret(octokit, owner, repo, secretName, secretValue) {
    try {
        // 1. Get the repo's public key (needed to encrypt the secret)
        const { data: publicKey } = await octokit.actions.getRepoPublicKey({
            owner,
            repo,
        });

        // 2. Encrypt the secret value using libsodium
        await sodium.ready;
        const binKey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
        const binSecret = sodium.from_string(secretValue);
        const encryptedBytes = sodium.crypto_box_seal(binSecret, binKey);
        const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

        // 3. Set the secret on the repo
        await octokit.actions.createOrUpdateRepoSecret({
            owner,
            repo,
            secret_name: secretName,
            encrypted_value: encryptedValue,
            key_id: publicKey.key_id,
        });

        console.log(`🔐 Secret '${secretName}' set on ${owner}/${repo}`);
    } catch (err) {
        console.error(`❌ Failed to set secret '${secretName}':`, err.message);
    }
}





async function getAuthenticatedOctokit(installationId) {
    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: 3125450, // From your screenshot
            privateKey: privateKey,
            installationId: installationId, // This comes from the Webhook payload
        },
    });
}


// 1. The Blueprint Content (Your working code as a string)
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

const app = express();
const PORT =  6001;

app.use(bodyParser.json());

// Configure AWS using Environment Variables for Security
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-south-1'
});

const s3 = new AWS.S3();

const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_API_HEADERS = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};


// 2. Function to inject/update the workflow file via GitHub API (using PAT)
async function autoInjectWorkflow(repoFullName) {
    const url = `https://api.github.com/repos/${repoFullName}/contents/.github/workflows/deploy.yml`;
    
    try {
        // Check if it already exists to get its SHA
        let existingSha = null;
        try {
            const { data } = await axios.get(url, { headers: GITHUB_API_HEADERS });
            existingSha = data.sha;

            // Check if the content is already up-to-date
            const existingContent = Buffer.from(data.content, 'base64').toString('utf8');
            if (existingContent.trim() === DEPLOY_YAML_BLUEPRINT.trim()) {
                console.log(`✅ Workflow in ${repoFullName} is already up-to-date.`);
                return { status: 'up-to-date' };
            }
        } catch (e) {
            // File doesn't exist yet, that's fine
        }

        const payload = {
            message: "chore: auto-inject faceplate deployment pipeline",
            content: Buffer.from(DEPLOY_YAML_BLUEPRINT).toString('base64'),
        };
        if (existingSha) payload.sha = existingSha;

        await axios.put(url, payload, { headers: GITHUB_API_HEADERS });
        console.log(`✅ Pipeline injected/updated in ${repoFullName}`);
        return { status: 'updated' };
    } catch (err) {
        console.error("Injection failed:", err.response?.data || err.message);
        return { status: 'failed', error: err.message };
    }
}

// RE-INJECT endpoint: Update workflow in any existing repo
// Usage: GET http://localhost:6001/re-inject/heetp0101/cozy-corner-cafe-52
app.get('/re-inject/:owner/:repo', async (req, res) => {
    const { owner, repo } = req.params;
    console.log(`🔄 Re-injecting workflow into ${owner}/${repo}...`);
    const result = await autoInjectWorkflow(`${owner}/${repo}`);
    res.json({ repo: `${owner}/${repo}`, ...result });
});

// RE-INJECT ALL: Update workflow in ALL your repos
// Usage: GET http://localhost:6001/re-inject-all/heetp0101
app.get('/re-inject-all/:owner', async (req, res) => {
    const { owner } = req.params;
    console.log(`🔄 Re-injecting workflow into ALL repos for ${owner}...`);

    try {
        const { data: repos } = await axios.get(
            `https://api.github.com/user/repos?type=owner&sort=created&direction=desc&per_page=50`,
            { headers: GITHUB_API_HEADERS }
        );

        const results = [];
        for (const repo of repos) {
            if (repo.owner.login !== owner) continue;
            // Only inject into repos that already have the workflow
            try {
                await axios.get(
                    `https://api.github.com/repos/${owner}/${repo.name}/contents/.github/workflows/deploy.yml`,
                    { headers: GITHUB_API_HEADERS }
                );
                const result = await autoInjectWorkflow(`${owner}/${repo.name}`);
                results.push({ repo: repo.name, ...result });
            } catch (e) {
                // No workflow file — skip this repo
                results.push({ repo: repo.name, status: 'skipped (no workflow)' });
            }
        }

        console.log('✅ Re-injection complete:', results);
        res.json({ results });
    } catch (err) {
        console.error('❌ Re-inject all failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.post('/webhook', async (req, res) => {
    const eventType = req.headers['x-github-event'];
    const payload = req.body;

    // 1. HANDLE NEW REPO (Lovable "Connect" button)
    // Inside your webhook handler, update the 'repository created' block:
    if (eventType === 'repository' && payload.action === 'created') {
        const owner = payload.repository.owner.login;
        const repo = payload.repository.name;
        const workflowPath = ".github/workflows/deploy.yml";

        console.log(`✨ New Repo Detected: ${owner}/${repo}`);
        
        try {
            const installationId = payload.installation.id; 
            const octokit = await getAuthenticatedOctokit(installationId);

            // 1. Check if the file already exists to get its SHA fingerprint
            let existingSha = null;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: workflowPath,
                });
                existingSha = data.sha;
                console.log("🔍 Workflow exists, preparing update...");
            } catch (e) {
                console.log("🆕 Workflow doesn't exist, creating fresh...");
            }

            // 2. Create or Update the workflow file
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: workflowPath,
                message: "chore: auto-inject deployment pipeline",
                content: Buffer.from(DEPLOY_YAML_BLUEPRINT).toString("base64"),
                sha: existingSha,
                branch: "main"
            });
            console.log("✅ Workflow injected successfully.");

            // 3. AUTO-INJECT AWS SECRETS
            console.log("🔐 Injecting AWS secrets...");
            await setRepoSecret(octokit, owner, repo, "AWS_ACCESS_KEY_ID", process.env.AWS_ACCESS_KEY_ID);
            await setRepoSecret(octokit, owner, repo, "AWS_SECRET_ACCESS_KEY", process.env.AWS_SECRET_ACCESS_KEY);
            console.log("✅ All secrets injected successfully.");

            return res.status(200).send('Workflow + Secrets Injected');

        } catch (err) {
            console.error("❌ Injection failed:", err.message);
            return res.status(500).send('Injection Failed');
        }
    }

    // 2. HANDLE CODE UPDATES (Push event)
    if (eventType === 'push') {
        console.log('--- New commit detected! ---');
        
        const repoUrl = payload.repository.clone_url;
        const localPath = path.join(__dirname, 'temp_deploy');

        try {
            // 1. Pull the latest code
            if (!fs.existsSync(localPath)) {
                await git.clone(repoUrl, localPath);
            } else {
                await git.cwd(localPath).pull();
            }

            const possiblePaths = [
                path.join(localPath, 'Conversations', 'messages'),
                path.join(localPath, 'Conversations', 'messages.txt')
            ];

            let messagesPath = possiblePaths.find(p => fs.existsSync(p));
            
            if (messagesPath) {
                const content = fs.readFileSync(messagesPath, 'utf8');
                const lines = content.trim().split('\n');
                const lastLine = lines[lines.length - 1].trim(); 

                console.log(`Checking command: "${lastLine}"`);
                const deployMatch = lastLine.match(/DEPLOY:\s*(\S+)\s*TO:\s*(\S+)/i);

                if (deployMatch) {
                    const siteName = deployMatch[1];
                    const environment = deployMatch[2].toLowerCase();
                    const bucketName = `heet-faceplate-${environment}`;
                    
                    console.log(`🚀 Starting Build for ${siteName}...`);

                    const buildCmd = `npm install && VITE_BASE_PATH=/${siteName}/ npm run build`;
                    execSync(buildCmd, { cwd: localPath, stdio: 'inherit' });

                    const buildFolder = path.join(localPath, 'dist'); 
                    execSync(`aws s3 sync "${buildFolder}" "s3://${bucketName}/${siteName}" --delete`, { stdio: 'inherit' });

                    const cfId = process.env.CLOUDFRONT_DISTRIBUTION_ID || 'E2QOC59EK5LGU4';
                    execSync(`aws cloudfront create-invalidation --distribution-id ${cfId} --paths "/*"`, { stdio: 'inherit' });

                    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
                    const responseMsg = `DEPLOYED: ${siteName} TO: ${environment} AT: ${timestamp} URL: http://${bucketName}.s3-website.${AWS.config.region}.amazonaws.com/${siteName}/`;

                    fs.appendFileSync(messagesPath, `\n${responseMsg}\n`);
                    await git.cwd(localPath).add('Conversations/*').commit('Automated Deploy Response').push();
                    console.log(`✅ Deployment Complete!`);
                }
            }
            return res.status(200).send('Push Processed');
        } catch (error) {
            console.error("Error during push processing:", error);
            return res.status(500).send('Push Processing Failed');
        }
    }

    // 3. FALLBACK (For events we don't care about)
    return res.status(200).send('Event Ignored');
});


app.listen(PORT, () => {
    console.log(`Orchestrator online on port ${PORT}. Waiting for GitHub webhooks...`);
});