const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

// Set the view engine to EJS
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Read JSON data from files
const foodImportsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'foodImports.json')));
const gdpExportsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'gdpExports.json')));
const localFoodData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'localFood.json')));

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/calculate', (req, res) => {
    const { country } = req.body;

    try {
        // Extract data from JSON
        const foodImports = foodImportsData[country] || 0;
        const gdpFromExports = gdpExportsData[country] || 0;
        const localFood = localFoodData[country] || 0;

        // Perform calculations
        const calculatedData = calculateDependencyMetrics(foodImports, gdpFromExports, localFood);

        // Render the result view with the calculated data
        res.render('result', { data: calculatedData, country });
    } catch (error) {
        console.error('Error fetching data:', error.message);
        res.status(500).send('An error occurred while fetching data. Please try again later.');
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});

function calculateDependencyMetrics(foodImports, gdpFromExports, localFood) {
    // Example calculations
    const totalDependency = (foodImports + gdpFromExports) / (localFood + foodImports + gdpFromExports);
    // More metrics can be calculated here

    return {
        foodImports,
        gdpFromExports,
        localFood,
        totalDependency,
        // Add more calculated metrics if needed
    };
}
