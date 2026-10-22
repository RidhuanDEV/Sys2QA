# Workflow: Submit registration

Revision `4b775e0c2a9d` · profile `standard` · status `partially_reconstructed`

1. Open `page:web:/registrasi`.
2. Submit `form:web:/registrasi#registration` (validation: `business_rule:registration.nib_required_13_digits`).
3. `api:POST:/api/registrations` writes `entity:registration` and calls `integration:email.confirmation`.

Unresolved: email delivery happens outside the repository (`gap:email-delivery`).
