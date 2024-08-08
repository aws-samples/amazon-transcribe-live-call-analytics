/* eslint-disable implicit-arrow-linebreak */
import * as XLSX from 'xlsx';

export const onImportExcelAsync = (file) =>
  new Promise((resolve, reject) => {
    const { files } = file.target;
    const fileReader = new FileReader();
    fileReader.onload = (event) => {
      const { result } = event.target;
      const workbook = XLSX.read(result, { type: 'binary' });
      let data = [];
      // iterate over each worksheet to read (here only the first table is read by default)
      // eslint-disable-next-line no-restricted-syntax
      for (const sheet in workbook.Sheets) {
        // eslint-disable-next-line no-prototype-builtins
        if (workbook.Sheets.hasOwnProperty(sheet)) {
          data = data.concat(XLSX.utils.sheet_to_json(workbook.Sheets[sheet]));
        }
      }
      resolve(data);
    };
    fileReader.onerror = reject;
    fileReader.readAsBinaryString(files[0]);
  });

export const exportToExcel = async (data, nameFile) => {
  if (data.length > 0) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data, { origin: 'A2' });
    XLSX.utils.sheet_add_aoa(ws, []); // heading: array of arrays
    XLSX.utils.book_append_sheet(wb, ws);
    XLSX.writeFile(wb, `${nameFile}.xlsx`);
  }
};
