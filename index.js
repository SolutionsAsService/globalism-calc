const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/calculate', async (req, res) => {
    const { country } = req.body;

    try {
        // Replace with actual API endpoints
        const foodImportsResponse = await axios.get(`https://api.example.com/food-imports?country=${country}`);
        const gdpExportsResponse = await axios.get(`https://api.example.com/gdp-exports?country=${country}`);
        const localFoodResponse = await axios.get(`https://api.example.com/local-food?country=${country}`);

        // Extract data from responses
        const foodImports = foodImportsResponse.data.value;
        const gdpFromExports = gdpExportsResponse.data.value;
        const localFood = localFoodResponse.data.value;

        // Perform calculations
        const calculatedData = calculateDependencyMetrics(foodImports, gdpFromExports, localFood);

        // Render the result view with the calculated data
        res.render('result', { data: calculatedData });
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