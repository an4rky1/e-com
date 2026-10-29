/**
 * @fileoverview State lives in S3 — configured by hand, never by a variable.
 *
 * @remarks A backend block takes no variables, which is why the bucket, table and region
 * are literals repeated from `infra/bootstrap`'s defaults. Changing them means changing
 * both directories in one commit; the coupling is visible on purpose, because the
 * alternative (a backend that reads a value a variable provides) does not exist.
 *
 * @remarks The `key` is the only line that differs from dev — one state per environment.
 */
terraform {
  backend "s3" {
    bucket         = "auth-platform-tfstate"
    key            = "auth-platform/prod/terraform.tfstate"
    region         = "eu-central-1"
    dynamodb_table = "auth-platform-locks"
    encrypt        = true
  }
}
