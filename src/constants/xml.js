const COMMAND_NAME_TAG = 'command-name';
const COMMAND_MESSAGE_TAG = 'command-message';
const COMMAND_ARGS_TAG = 'command-args';

const BASH_INPUT_TAG = 'bash-input';
const BASH_STDOUT_TAG = 'bash-stdout';
const BASH_STDERR_TAG = 'bash-stderr';
const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout';
const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr';
const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat';

const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG
];

const TICK_TAG = 'tick';

const TASK_NOTIFICATION_TAG = 'task-notification';
const TASK_ID_TAG = 'task-id';
const TOOL_USE_ID_TAG = 'tool-use-id';
const TASK_TYPE_TAG = 'task-type';
const OUTPUT_FILE_TAG = 'output-file';
const STATUS_TAG = 'status';
const SUMMARY_TAG = 'summary';
const REASON_TAG = 'reason';

const TEAMMATE_MESSAGE_TAG = 'teammate-message';
const CHANNEL_MESSAGE_TAG = 'channel-message';
const CHANNEL_TAG = 'channel';

const COMMON_HELP_ARGS = ['help', '-h', '--help'];

const COMMON_INFO_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?'
];

module.exports = {
  COMMAND_NAME_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_ARGS_TAG,
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TERMINAL_OUTPUT_TAGS,
  TICK_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_ID_TAG,
  TOOL_USE_ID_TAG,
  TASK_TYPE_TAG,
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  REASON_TAG,
  TEAMMATE_MESSAGE_TAG,
  CHANNEL_MESSAGE_TAG,
  CHANNEL_TAG,
  COMMON_HELP_ARGS,
  COMMON_INFO_ARGS
};
