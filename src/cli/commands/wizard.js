/**
 * CLI 命令 - 向导
 */

const { SetupWizard } = require('../../core');

async function handleWizardCommand(args) {
  const type = args[0] || 'setup';
  
  const wizard = new SetupWizard();
  
  switch (type) {
    case 'setup':
      await wizard.runSetup();
      break;
    case 'model':
      await wizard.configureModel();
      break;
    case 'channel':
      await wizard.configureChannel();
      break;
    case 'skill':
      await wizard.configureSkill();
      break;
    default:
      printWizardHelp();
  }
}

function printWizardHelp() {
  console.log(`
向导命令:
  wizard setup      运行初始设置向导
  wizard model      配置模型
  wizard channel    配置通道
  wizard skill      配置技能
`);
}

module.exports = {
  handleWizardCommand
};
