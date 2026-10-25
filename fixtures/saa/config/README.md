# Configuration fixture (IMP-109)

Proves the `config` adapter: an environment template, a Dockerfile, a Compose file whose environment holds the planted
fake password from `fixtures/security/planted-secrets.json`, a GitHub Actions workflow with a secret, and a
`postinstall` script that would leave a sentinel file if it ever ran. Expected: configuration keys by name only (no
value anywhere in the output), deployment units for the image, both Compose services and the CI job, `secret_ref`
`DEPLOY_TOKEN`, and a coverage note for the install script.
