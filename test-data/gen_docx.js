// 生成测试用《工业自动化设备采购合同》docx（bilateral 模板，纯黑，1.5倍行距）
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, WidthType, BorderStyle } = require("docx");
const fs = require("fs");

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };
const F = { eastAsia: "SimSun", ascii: "Times New Roman" };
const FH = { eastAsia: "SimHei", ascii: "Times New Roman" };

const title = new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { line: Math.ceil(22 * 23), lineRule: "atLeast", after: 200 },
  children: [new TextRun({ text: "\u5de5\u4e1a\u81ea\u52a8\u5316\u8bbe\u5907\u91c7\u8d2d\u5408\u540c", size: 44, bold: true, color: "000000", font: FH })],
});
const contractNo = new Paragraph({
  alignment: AlignmentType.RIGHT,
  children: [new TextRun({ text: "\u5408\u540c\u7f16\u53f7\uff1aCA-HT-2026-0912", size: 21, color: "000000", font: F })],
});

function partyBlock(label, fields) {
  const header = new Paragraph({
    spacing: { before: 200, after: 100, line: 360 },
    children: [new TextRun({ text: label, size: 24, color: "000000", font: F, bold: true })],
  });
  const table = new Table({
    width: { size: 90, type: WidthType.PERCENTAGE },
    borders: noBorders,
    rows: fields.map(([k, v]) => new TableRow({
      cantSplit: true,
      children: [
        new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, borders: noBorders,
          margins: { top: 40, bottom: 40, left: 420, right: 60 },
          children: [new Paragraph({ children: [new TextRun({ text: k + "\uff1a", size: 24, color: "000000", font: F })] })] }),
        new TableCell({ borders: noBorders,
          margins: { top: 40, bottom: 40, left: 60, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: v, size: 24, color: "000000", font: F })] })] }),
      ],
    })),
  });
  return [header, table];
}

function clause(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 480 },
    spacing: { line: 360 },
    children: [new TextRun({ text, size: 24, color: "000000", font: F })],
  });
}
function clauseHead(text) {
  return new Paragraph({
    spacing: { before: 240, after: 120, line: 360 },
    children: [new TextRun({ text, size: 24, bold: true, color: "000000", font: FH })],
  });
}

const body = [
  title, contractNo,
  ...partyBlock("\u7532\u65b9\uff08\u4e70\u65b9\uff09\uff1a\u5b8f\u8fbe\u673a\u68b0\u5236\u9020\u6709\u9650\u516c\u53f8", [
    ["\u7edf\u4e00\u793e\u4f1a\u4fe1\u7528\u4ee3\u7801", "91310000MA1FL888XX"],
    ["\u5730\u5740", "\u4e0a\u6d77\u5e02\u677e\u6c5f\u533a\u5de5\u4e1a\u56ed\u533a\u5185\u73af\u8def 888 \u53f7"],
    ["\u6cd5\u5b9a\u4ee3\u8868\u4eba", "\u5218\u5efa\u56fd"],
    ["\u8054\u7cfb\u4eba/\u7535\u8bdd", "\u5f20\u654f / 021-6688-XXXX"],
  ]),
  ...partyBlock("\u4e59\u65b9\uff08\u5356\u65b9\uff09\uff1a\u9510\u950b\u81ea\u52a8\u5316\u8bbe\u5907\u6709\u9650\u516c\u53f8", [
    ["\u7edf\u4e00\u793e\u4f1a\u4fe1\u7528\u4ee3\u7801", "91310117MA1KK666YY"],
    ["\u5730\u5740", "\u4e0a\u6d77\u5e02\u677e\u6c5f\u533a\u79d1\u6280\u56ed\u6e05\u534e\u8def 666 \u53f7"],
    ["\u6cd5\u5b9a\u4ee3\u8868\u4eba", "\u5b59\u4e00\u9e23"],
    ["\u8054\u7cfb\u4eba/\u7535\u8bdd", "\u738b\u82b3 / 021-5566-XXXX"],
  ]),
  clauseHead("\u7b2c\u4e00\u6761  \u6807\u7684\u7269"),
  clause("1.1  \u7532\u65b9\u5411\u4e59\u65b9\u91c7\u8d2d PLC \u63a7\u5236\u5668 CPU \u6a21\u5757 20 \u53f0\u3001\u4f3a\u670d\u7535\u673a 750W 50 \u53f0\u3001\u89e6\u6478\u5c4f 10.1 \u5bf8 15 \u53f0\uff0c\u5177\u4f53\u89c4\u683c\u4ee5\u672c\u5408\u540c\u9644\u4ef6\u4e00\u300a\u8bbe\u5907\u660e\u7ec6\u53ca\u6280\u672f\u53c2\u6570\u8868\u300b\u4e3a\u51c6\u3002\u9644\u4ef6\u662f\u672c\u5408\u540c\u4e0d\u53ef\u5206\u5272\u7684\u7ec4\u6210\u90e8\u5206\u3002"),
  clauseHead("\u7b2c\u4e8c\u6761  \u5408\u540c\u4ef7\u683c\u4e0e\u652f\u4ed8"),
  clause("2.1  \u672c\u5408\u540c\u603b\u4ef7\u4e3a\u4eba\u6c11\u5e01\u67d2\u62fe\u516b\u4e07\u516d\u5343\u5143\u6574\uff08\u00a5186,000.00\uff09\uff0c\u4e3a\u542b\u7a0e\u4ef7\uff0c\u542b\u9001\u8d27\u81f3\u7532\u65b9\u6307\u5b9a\u5730\u70b9\u7684\u8fd0\u8f93\u8d39\u7528\u3002"),
  clause("2.2  \u7532\u65b9\u5e94\u4e8e\u8bbe\u5907\u9a8c\u6536\u5408\u683c\u540e 30 \u4e2a\u65e5\u5185\uff0c\u5411\u4e59\u65b9\u6307\u5b9a\u94f6\u884c\u8d26\u6237\u4e00\u6b21\u6027\u652f\u4ed8\u5168\u90e8\u5408\u540c\u4ef7\u6b3e\u3002\u4e59\u65b9\u5e94\u4e8e\u6536\u6b3e\u524d\u5411\u7532\u65b9\u5f00\u5177\u589e\u503c\u7a0e\u4e13\u7528\u53d1\u7968\u3002"),
  clause("2.3  \u7532\u65b9\u903e\u671f\u4ed8\u6b3e\u7684\uff0c\u6bcf\u903e\u5ef6\u4e00\u65e5\u5e94\u6309\u903e\u671f\u91d1\u989d\u7684\u4e07\u5206\u4e4b\u4e94\u5411\u4e59\u65b9\u652f\u4ed8\u8fdd\u7ea6\u91d1\u3002"),
  clauseHead("\u7b2c\u4e09\u6761  \u4ea4\u8d27\u4e0e\u9a8c\u6536"),
  clause("3.1  \u4e59\u65b9\u5e94\u4e8e 2026 \u5e74 9 \u6708 30 \u65e5\u524d\u5c06\u5168\u90e8\u8bbe\u5907\u9001\u8fbe\u7532\u65b9\u5730\u5740\u3002\u903e\u671f\u4ea4\u8d27\u7684\uff0c\u6bcf\u903e\u5ef6\u4e00\u65e5\u5e94\u6309\u5408\u540c\u603b\u4ef7\u7684\u4e07\u5206\u4e4b\u4e94\u5411\u7532\u65b9\u652f\u4ed8\u8fdd\u7ea6\u91d1\uff0c\u903e\u671f\u8d85\u8fc7 30 \u65e5\u7684\uff0c\u7532\u65b9\u6709\u6743\u89e3\u9664\u672c\u5408\u540c\u3002"),
  clause("3.2  \u7532\u65b9\u5e94\u5728\u6536\u8d27\u540e 7 \u4e2a\u5de5\u4f5c\u65e5\u5185\u5b8c\u6210\u9a8c\u6536\uff1b\u5bf9\u8d28\u91cf\u6709\u5f02\u8bae\u7684\uff0c\u5e94\u5728\u5f02\u8bae\u671f\u5185\u4e66\u9762\u63d0\u51fa\uff0c\u4e59\u65b9\u5e94\u5728 15 \u65e5\u5185\u4e88\u4ee5\u66f4\u6362\u6216\u4fee\u590d\u3002"),
  clauseHead("\u7b2c\u56db\u6761  \u77e5\u8bc6\u4ea7\u6743\u4e0e\u4fdd\u5bc6"),
  clause("4.1  \u4e00\u65b9\u5bf9\u5728\u5c65\u7ea6\u8fc7\u7a0b\u4e2d\u77e5\u6089\u7684\u5bf9\u65b9\u5546\u4e1a\u79d8\u5bc6\u8d1f\u6709\u4fdd\u5bc6\u4e49\u52a1\uff0c\u4fdd\u5bc6\u671f\u81ea\u672c\u5408\u540c\u7b7e\u8ba2\u4e4b\u65e5\u8d77\u81f3\u5408\u540c\u7ec8\u6b62\u540e\u4e24\u5e74\u3002"),
  clause("4.2  \u672c\u5408\u540c\u4e0d\u6d89\u53ca\u4efb\u4f55\u6280\u672f\u6210\u679c\u6743\u5c5e\u8f6c\u8ba9\uff0c\u53cc\u65b9\u5404\u81ea\u62e5\u6709\u5176\u5148\u4e8e\u672c\u5408\u540c\u5b58\u5728\u7684\u77e5\u8bc6\u4ea7\u6743\u3002"),
  clauseHead("\u7b2c\u4e94\u6761  \u4e0d\u53ef\u6297\u529b"),
  clause("5.1  \u56e0\u4e0d\u53ef\u6297\u529b\u4e8b\u4ef6\u4e0d\u80fd\u5c65\u884c\u6216\u5ef6\u8fdf\u5c65\u884c\u672c\u5408\u540c\u7684\uff0c\u53d7\u5f71\u54cd\u65b9\u5e94\u5728\u4e8b\u4ef6\u53d1\u751f\u540e 7 \u65e5\u5185\u4e66\u9762\u901a\u77e5\u5bf9\u65b9\uff0c\u5e76\u91c7\u53d6\u5408\u7406\u63aa\u65bd\u51cf\u8f7b\u635f\u5931\uff1b\u4e8b\u4ef6\u6301\u7eed\u8d85\u8fc7 60 \u65e5\u7684\uff0c\u53cc\u65b9\u5e94\u534f\u5546\u540e\u7eed\u5c65\u7ea6\u5b89\u6392\u3002"),
  clauseHead("\u7b2c\u516d\u6761  \u4e89\u8bae\u89e3\u51b3"),
  clause("6.1  \u56e0\u672c\u5408\u540c\u5f15\u8d77\u7684\u4e89\u8bae\uff0c\u53cc\u65b9\u5e94\u5148\u534f\u5546\u89e3\u51b3\uff1b\u534f\u5546\u4e0d\u6210\u7684\uff0c\u5411\u7532\u65b9\u4f4f\u6240\u5730\u6709\u7ba1\u8f96\u6743\u7684\u4eba\u6c11\u6cd5\u9662\u63d0\u8d77\u8bc9\u8bbc\u3002"),
  clauseHead("\u7b2c\u4e03\u6761  \u5176\u4ed6"),
  clause("7.1  \u672c\u5408\u540c\u4e00\u5f0f\u4e24\u4efd\uff0c\u53cc\u65b9\u5404\u6267\u4e00\u4efd\uff0c\u81ea\u53cc\u65b9\u7b7e\u5b57\u76d6\u7ae0\u4e4b\u65e5\u8d77\u751f\u6548\u3002\u672a\u5c3d\u4e8b\u5b9c\uff0c\u53cc\u65b9\u53e6\u884c\u7b7e\u8ba2\u8865\u5145\u534f\u8bae\u3002"),
];

function sigCell(label) {
  return new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: noBorders,
    margins: { top: 80, bottom: 80, left: 120, right: 60 },
    children: [new Paragraph({ children: [new TextRun({ text: label, size: 24, color: "000000", font: F })] })] });
}
const sigFields = [
  ["\u7532\u65b9\uff08\u76d6\u7ae0\uff09\uff1a", "\u4e59\u65b9\uff08\u76d6\u7ae0\uff09\uff1a"],
  ["\u6cd5\u5b9a\u4ee3\u8868\u4eba/\u6388\u6743\u4ee3\u8868\uff08\u7b7e\u5b57\uff09\uff1a", "\u6cd5\u5b9a\u4ee3\u8868\u4eba/\u6388\u6743\u4ee3\u8868\uff08\u7b7e\u5b57\uff09\uff1a"],
  ["\u7b7e\u7f72\u5730\u70b9\uff1a\u4e0a\u6d77\u5e02\u677e\u6c5f\u533a", "\u7b7e\u7f72\u5730\u70b9\uff1a\u4e0a\u6d77\u5e02\u677e\u6c5f\u533a"],
  ["\u65e5\u671f\uff1a\u3010____/____/____\u3011", "\u65e5\u671f\uff1a\u3010____/____/____\u3011"],
];
const sigTable = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: noBorders,
  rows: sigFields.map(([a, b]) => new TableRow({ cantSplit: true, children: [sigCell(a), sigCell(b)] })),
});

const doc = new Document({
  styles: { default: { document: {
    run: { font: F, size: 24, color: "000000" },
    paragraph: { spacing: { line: 360 } },
  }}},
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 } } },
    children: [...body,
      new Paragraph({ spacing: { before: 300 }, children: [new TextRun({ text: "\uff08\u4ee5\u4e0b\u65e0\u6b63\u6587\uff09", size: 24, color: "000000", font: F })] }),
      sigTable,
      new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: "\u9644\u4ef6\u4e00\uff1a\u8bbe\u5907\u660e\u7ec6\u53ca\u6280\u672f\u53c2\u6570\u8868\uff08\u542b PLC \u63a7\u5236\u5668/\u4f3a\u670d\u7535\u673a/\u89e6\u6478\u5c4f\u89c4\u683c\u6e05\u5355\uff0c\u5171 1 \u9875\uff0c\u672c\u6d4b\u8bd5\u6587\u6863\u672a\u9644\u5177\u4f53\u53c2\u6570\uff09\u3002", size: 21, color: "000000", font: F })] }),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("D:/bossagent/test-data/\u5408\u540c\u6837\u672c_\u6d4b\u8bd5.docx", buf);
  console.log("docx saved");
});
