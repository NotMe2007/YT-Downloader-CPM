param(
  [switch]$Dev
)

if (!(Test-Path -Path "$PSScriptRoot/.env")) {
  Copy-Item "$PSScriptRoot/.env.example" "$PSScriptRoot/.env" -ErrorAction SilentlyContinue | Out-Null
  Write-Host "Created .env from .env.example. Please fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID."
}

Push-Location $PSScriptRoot
try {
  if (!(Test-Path -Path "node_modules")) {
    npm install
  }
  if ($Dev) {
    node ./src/register-commands.js
    npm run dev
  } else {
    node ./src/register-commands.js
    npm start
  }
} finally {
  Pop-Location
}
