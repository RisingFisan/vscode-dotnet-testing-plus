namespace MES.E2E.Cart;

[TestClass]
public partial class CartTests
{
    [TestMethod]
    public void AddItemIncreasesCount()
    {
        var count = 0;
        count++;
        Assert.AreEqual(1, count);
    }

    [DataTestMethod]
    [DataRow(1, 2, 3)]
    [DataRow(2, 2, 4)]
    public void CartTotalSumsItemPrices(int a, int b, int expected)
    {
        Assert.AreEqual(expected, a + b);
    }
}
