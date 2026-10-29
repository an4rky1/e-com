# Prod values. Everything that costs money or survives a mistake is set here explicitly,
# even where the variable default agrees: the point of this file is that a reader can see
# prod's posture without opening a single .tf.
environment              = "prod"
vpc_cidr                 = "10.30.0.0/16"
desired_count            = 2
db_instance_class        = "db.t4g.small"
db_multi_az              = true
db_backup_retention_days = 14
log_retention_days       = 90
task_cpu                 = "512"
task_memory              = "1024"

# Autoscaling set explicitly, like everything else above: min matches desired_count so a
# quiet week cannot shrink the fleet this file chose, max is the headroom a spike gets
# before a human is paged.
autoscaling = {
  min_capacity = 2
  max_capacity = 8
}
