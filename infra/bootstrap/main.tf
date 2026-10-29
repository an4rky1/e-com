/**
 * @fileoverview The account-level stack: state backend and the shared image repositories.
 *
 * @remarks S3 holds every environment's state and DynamoDB locks it. Both are here because
 * this is the one directory that must work before anything else exists — the classic
 * Terraform chicken-and-egg, solved once.
 *
 * @remarks ECR lives here rather than in an environment: `auth-platform/<service>` is
 * shared by dev and prod (one image per git SHA, `make push` writes without knowing which
 * environment is deploying), and two environment states both creating the same repository
 * would fight over one name. The service list comes from the same catalog the platform
 * module builds task definitions from, so a new service gets its repository the same
 * commit it gets its task definition.
 *
 * @remarks `force_destroy` is false on purpose: `terraform destroy` on bootstrap refuses
 * to silently take every environment's state with it. Deleting this stack is a deliberate,
 * separate act.
 */

module "catalog" {
  source = "../modules/catalog"
}

resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket
  force_destroy = false

  tags = {
    Name        = var.state_bucket
    ManagedBy   = "terraform"
    Purpose     = "terraform-state"
    Environment = "global"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "locks" {
  name         = var.lock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name      = var.lock_table
    ManagedBy = "terraform"
    Purpose   = "terraform-locks"
  }
}

resource "aws_ecr_repository" "apps" {
  for_each = module.catalog.services

  # `auth-platform/identity` and friends: the nested name is exactly what `make push`
  # addresses ($URI/identity where $URI ends in /auth-platform), so no rewrite is needed
  # on either side.
  name                 = "${var.ecr_repository_prefix}/${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # Images outlive a destroy only if the operator asks for it: the default keeps a
  # mistaken `destroy` from quietly erasing every image the environments still run.
  force_delete = var.ecr_force_delete

  tags = {
    Service     = each.key
    ManagedBy   = "terraform"
    Purpose     = "service-images"
    Environment = "global"
  }
}
