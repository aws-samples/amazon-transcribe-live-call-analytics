# LCA Agent Assist Demo

### Part 1: AgentAssist gathers some information for later use - eg credit card type and caller’s first name.
  
**Agent**: Hello! Thanks for calling ACME Bank. My name is Oliver. How can i help you?
**Caller**: Hi. I’m calling about my **Rewards** card. 
**Agent**: Excellent.. give me a second to look up your customer account..  

*AGENT ASSIST:  Ask caller to state their first name only, for verification purposes. It should be ‘Bob’ per callerId lookup.*
  
**Agent**: For verification purposes, can you please state your first name?
**Caller**: My first name is **Bob**. 
**Agent**: one moment while we verify* that your name matches our records.*  

*AGENT ASSIST: Suggested response: “Perfect! Hi ****Bob****. How can i help you with your rewards-card?”*  

**Agent**:  It matches - perfect! Hi Bob. How can i help you with your rewards-card?*

### Part 2: AgentAssist retrieves information using the information gathered earlier (eg card type).. in this case by using conditional answer in QnAbot, but other mechanisms -  such as kendra redirect query filters or custom logic with Lambda hooks - could also be used.


**Caller**: I was wondering, what is the cash back rate for this card?
**Agent**:  I’m looking that up for you now. It won’t take long.   

*AGENTASSIST: Suggested response: Yes, I see here that the rewards card has a 2% cashback rate on your everyday spending. Did that answer your question? Anything else I can help with today?*
  
**Agent**: Yes, I see here that the rewards card has a 2% cashback rate on your everyday spending. Did that answer your question? Anything else I can help with today?

### Part 3: AgentAssist can guide agent through an online transaction, prompting agent to collect the needed information. Potentially AgentAssist could fully automate transaction fulfillment.
 
**Caller**: Thanks, yes. Can i pay my card bill now while I’m on the phone?
**Agent**:  Yes, absolutely, we can process your payment over the phone. Give me a second to set that up.  

*AGENT ASSIST: Ask caller for last 4 digits of card number*
  
**Agent**: Can you please confirm the last 4 digits of your card number?
**Caller**: Yes. It’s 1234
**Agent**:  Got it - 1234.  
  
*AGENT ASSIST: Confirm card balance (eg $75.34). Ask caller how much they want to pay ($50 minimum)*
  
**Agent**: Great. I see that your card balance is $75.34. How much do you want to pay? There’s a $50 minimum payment.
**Caller**: I’ll pay $50
**Agent**:  OK, I’m entering payment for $50.  
  
*AGENT ASSIST: Ask caller if they want to pay from their checking or savings account*
  
**Agent**: Which account do you want to pay that from.. Your Savings account, or your Checking account?
**Caller**: My checking account.
**Agent**:  Your checking account - perfect. One moment please.  
  
*AGENT ASSIST: All information captured.. Last 4 = 1234, Amount = $50, Account = Checking*
  
**Agent**: Great, so I’ve processed payment of $50 from your Checking account.  Is there anything else I can help you with?

### Part 4: Caller asks a question where we have an Kendra FAQ answer in QnABot

**Caller**: Can you tell me what kinds of life insurance policies you have?  
**Agent**:  Yes, of course. I’m just pulling up our latest life insurance policy information now.  
  
*AGENT ASSIST: Open *[*https://www.barclays.co.uk/insurance/life-insurance/  Suggested response: We offer two main types of life insurance - Permanent life insurance, and Term life insurance which includes a plan designed for anyone thinking of applying for a mortgage.*
  
**Agent**: We offer two main types of life insurance - Permanent life insurance, and Term life insurance which includes a plan designed for anyone thinking of applying for a mortgage.


### Part 5: Caller asks a question for which we don’t have an FAQ.. Demonstrates fallback to a Kendra query on unstructured docs from the index (in the case the crawled website)

**Caller**: Actually I am thinking to apply for a mortgage. This would be my first time..
**Agent**: Excellent. That must be very exciting! We’d love to help you with that.  
  
*AGENT ASSIST: Amazon Kendra suggestions....you want to borrow as a deposit – but some of our **mortgages** are designed to help if you’re struggling to save up that amount. For example, you could **apply** for a **mortgage** with a minimum 5% deposit using the **mortgage** guarantee scheme. More **first**-**time** **mortgage** questions...*
*Source Link: https://www.barclays.co.uk/mortgages/first-time-buyers/*
  
**Agent**: We have mortgage solutions designed just for first time buyers like yourself, with down-payment options as low as 5%. Let me send you some information and let’s schedule a chat with one of our mortgage specialists. Does that sound OK?

### Part 6: Wrapup

**Caller**: That sounds great. Thanks. 
**Agent**: Is there anything else I can help you with today?
**Caller**: Nothing else just now. You’ve been a big help. Thank you so much.
**Agent**: No problem. I am very glad to hear you say that I was able to help you today.   
  
*AGENT ASSIST: Thanks Bob! We appreciate your business. Check out our website at ACMEBank.com to learn about all our other products, and feel free to call back if you have any additional questions. Have a great day.*
  
**Agent**: Thanks Bob! We appreciate your business. Check out our website at [ACMEBank.com](http://acme.com/) to learn about all our other products, and feel free to call back if you have any additional questions. Have a great day.
**Caller**: Thanks. Bye.
**Agent**: Goodbye.
 





 


