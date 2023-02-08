import * as XLSX from 'xlsx';
export const onImportExcelAsync = (file) => {
    return new Promise((resolve, reject) => {
        // Obtener el objeto del archivo cargado
        const { files } = file.target;
        // Leer el archivo a través del objeto FileReader

        const fileReader = new FileReader();
        fileReader.onload = event => {

            const { result } = event.target;
            // Leer en secuencia binaria para obtener todo el objeto de tabla de Excel
            const workbook = XLSX.read(result, { type: 'binary' });
            let data = []; // almacena los datos obtenidos
            // recorre cada hoja de trabajo para leer (aquí solo se lee la primera tabla por defecto)
            for (const sheet in workbook.Sheets) {
                if (workbook.Sheets.hasOwnProperty(sheet)) {
                    // usa el método sheet_to_json para convertir Excel a datos json
                    data = data.concat(XLSX.utils.sheet_to_json(workbook.Sheets[sheet]));
                    // break; // Si solo se toma la primera tabla, descomenta esta línea
                }
            }
            resolve(data);

            // Aquí puede lanzar una solicitud relacionada para un error de tipo de archivo incorrecto

        }
        fileReader.onerror = reject;
        // Abre el archivo en modo binario
        fileReader.readAsBinaryString(files[0]);
    })
}

export const  exportToExcel = async (data, nameFile) =>{
 
       if(data.length > 0){

           var wb = XLSX.utils.book_new();
           
           var ws = XLSX.utils.json_to_sheet(data, { origin: 'A2', });
           XLSX.utils.sheet_add_aoa(ws,[]); //heading: array of arrays
           
           XLSX.utils.book_append_sheet(wb, ws); 
           
           XLSX.writeFile(wb, `${nameFile}.xlsx`) 
       }
   }